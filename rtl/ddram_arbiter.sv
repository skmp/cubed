//
// DDR3 arbiter - multiplexes 3 requestors onto a single ddram_ctrl.
//
// Requestors:
//   [0] Coordinator (poll reads, header reads, frame_done writes)
//   [1] Core 0 (splat reads, tile flush writes)
//   [2] Core 1 (splat reads, tile flush writes)
//
// Policy: Round-robin grant at idle. Once granted, held until the
// entire transaction completes:
//   - Reads: held until all burst data words received (rd_data_valid count)
//   - Writes: held until wr_ack (single-word bursts only in this design)
//
// Read data is broadcast to all requestors but rd_data_valid is gated
// so only the granted requestor sees it.
//

module ddram_arbiter (
	input         clk,
	input         reset,

	// Downstream: single ddram_ctrl interface
	output [28:0] dc_rd_addr,
	output  [7:0] dc_rd_burstcnt,
	output        dc_rd_req,
	input         dc_rd_ack,
	input  [63:0] dc_rd_data,
	input         dc_rd_data_valid,

	output [28:0] dc_wr_addr,
	output  [7:0] dc_wr_burstcnt,
	output [63:0] dc_wr_data,
	output  [7:0] dc_wr_be,
	output        dc_wr_req,
	input         dc_wr_ack,
	input         dc_wr_busy,

	// Requestor 0 (coordinator)
	input  [28:0] r0_rd_addr,
	input   [7:0] r0_rd_burstcnt,
	input         r0_rd_req,
	output        r0_rd_ack,
	output [63:0] r0_rd_data,
	output        r0_rd_data_valid,
	input  [28:0] r0_wr_addr,
	input   [7:0] r0_wr_burstcnt,
	input  [63:0] r0_wr_data,
	input   [7:0] r0_wr_be,
	input         r0_wr_req,
	output        r0_wr_ack,
	output        r0_wr_busy,

	// Requestor 1 (core 0)
	input  [28:0] r1_rd_addr,
	input   [7:0] r1_rd_burstcnt,
	input         r1_rd_req,
	output        r1_rd_ack,
	output [63:0] r1_rd_data,
	output        r1_rd_data_valid,
	input  [28:0] r1_wr_addr,
	input   [7:0] r1_wr_burstcnt,
	input  [63:0] r1_wr_data,
	input   [7:0] r1_wr_be,
	input         r1_wr_req,
	output        r1_wr_ack,
	output        r1_wr_busy,

	// Requestor 2 (core 1)
	input  [28:0] r2_rd_addr,
	input   [7:0] r2_rd_burstcnt,
	input         r2_rd_req,
	output        r2_rd_ack,
	output [63:0] r2_rd_data,
	output        r2_rd_data_valid,
	input  [28:0] r2_wr_addr,
	input   [7:0] r2_wr_burstcnt,
	input  [63:0] r2_wr_data,
	input   [7:0] r2_wr_be,
	input         r2_wr_req,
	output        r2_wr_ack,
	output        r2_wr_busy
);

// ============================================================
// Grant FSM
// ============================================================

localparam GS_IDLE     = 2'd0;
localparam GS_RD_WAIT  = 2'd1;  // waiting for read burst data
localparam GS_WR_WAIT  = 2'd2;  // waiting for write ack

reg [1:0] gstate;
reg [1:0] grant;       // currently granted requestor (0, 1, 2)
reg [1:0] last_grant;  // for round-robin fairness
reg [7:0] rd_burst_remain;  // words remaining in read burst

// Detect any pending request from each requestor
wire r0_any_req = r0_rd_req | r0_wr_req;
wire r1_any_req = r1_rd_req | r1_wr_req;
wire r2_any_req = r2_rd_req | r2_wr_req;
wire any_req = r0_any_req | r1_any_req | r2_any_req;

// Which type of request the granted requestor is making
wire granted_rd_req = (grant == 2'd0) ? r0_rd_req :
                      (grant == 2'd1) ? r1_rd_req :
                                        r2_rd_req;

wire [7:0] granted_rd_burstcnt = (grant == 2'd0) ? r0_rd_burstcnt :
                                 (grant == 2'd1) ? r1_rd_burstcnt :
                                                   r2_rd_burstcnt;

// Round-robin next grant selection
reg [1:0] next_grant;
always @(*) begin
	next_grant = 2'd0;
	case (last_grant)
	2'd0: begin
		if      (r1_any_req) next_grant = 2'd1;
		else if (r2_any_req) next_grant = 2'd2;
		else if (r0_any_req) next_grant = 2'd0;
	end
	2'd1: begin
		if      (r2_any_req) next_grant = 2'd2;
		else if (r0_any_req) next_grant = 2'd0;
		else if (r1_any_req) next_grant = 2'd1;
	end
	2'd2: begin
		if      (r0_any_req) next_grant = 2'd0;
		else if (r1_any_req) next_grant = 2'd1;
		else if (r2_any_req) next_grant = 2'd2;
	end
	default: begin
		if      (r0_any_req) next_grant = 2'd0;
		else if (r1_any_req) next_grant = 2'd1;
		else if (r2_any_req) next_grant = 2'd2;
	end
	endcase
end

always @(posedge clk) begin
	if (reset) begin
		gstate         <= GS_IDLE;
		grant          <= 2'd0;
		last_grant     <= 2'd0;
		rd_burst_remain <= 8'd0;
	end else begin
		case (gstate)
		GS_IDLE: begin
			if (any_req) begin
				grant <= next_grant;
				// Determine if this is a read or write
				// (check on next cycle once grant is latched)
				gstate <= GS_WR_WAIT;  // default, overridden below
				// We need to check what the selected requestor wants.
				// Since next_grant is combinational, we can check now.
				case (next_grant)
				2'd0: if (r0_rd_req) gstate <= GS_RD_WAIT;
				2'd1: if (r1_rd_req) gstate <= GS_RD_WAIT;
				2'd2: if (r2_rd_req) gstate <= GS_RD_WAIT;
				default: ;
				endcase
			end
		end

		GS_RD_WAIT: begin
			// Latch burst count when rd_ack fires
			if (dc_rd_ack) begin
				rd_burst_remain <= granted_rd_burstcnt;
			end
			// Count down as data arrives
			if (dc_rd_data_valid) begin
				rd_burst_remain <= rd_burst_remain - 8'd1;
				if (rd_burst_remain == 8'd1) begin
					// Last word received
					last_grant <= grant;
					gstate     <= GS_IDLE;
				end
			end
		end

		GS_WR_WAIT: begin
			// Release after write is accepted
			if (dc_wr_ack) begin
				last_grant <= grant;
				gstate     <= GS_IDLE;
			end
		end

		default: gstate <= GS_IDLE;
		endcase
	end
end

wire granted = (gstate != GS_IDLE);

// ============================================================
// Mux downstream signals based on grant
// ============================================================

// Read channel mux
assign dc_rd_addr     = (grant == 2'd0) ? r0_rd_addr :
                         (grant == 2'd1) ? r1_rd_addr :
                                           r2_rd_addr;

assign dc_rd_burstcnt = (grant == 2'd0) ? r0_rd_burstcnt :
                         (grant == 2'd1) ? r1_rd_burstcnt :
                                           r2_rd_burstcnt;

assign dc_rd_req      = granted && ((grant == 2'd0) ? r0_rd_req :
                                    (grant == 2'd1) ? r1_rd_req :
                                                      r2_rd_req);

// Write channel mux
assign dc_wr_addr     = (grant == 2'd0) ? r0_wr_addr :
                         (grant == 2'd1) ? r1_wr_addr :
                                           r2_wr_addr;

assign dc_wr_burstcnt = (grant == 2'd0) ? r0_wr_burstcnt :
                         (grant == 2'd1) ? r1_wr_burstcnt :
                                           r2_wr_burstcnt;

assign dc_wr_data     = (grant == 2'd0) ? r0_wr_data :
                         (grant == 2'd1) ? r1_wr_data :
                                           r2_wr_data;

assign dc_wr_be       = (grant == 2'd0) ? r0_wr_be :
                         (grant == 2'd1) ? r1_wr_be :
                                           r2_wr_be;

assign dc_wr_req      = granted && ((grant == 2'd0) ? r0_wr_req :
                                    (grant == 2'd1) ? r1_wr_req :
                                                      r2_wr_req);

// ============================================================
// Demux upstream signals (ack/data) to granted requestor
// ============================================================

// Read data is broadcast (only granted requestor consumes it)
assign r0_rd_data       = dc_rd_data;
assign r1_rd_data       = dc_rd_data;
assign r2_rd_data       = dc_rd_data;

assign r0_rd_data_valid = dc_rd_data_valid && granted && (grant == 2'd0);
assign r1_rd_data_valid = dc_rd_data_valid && granted && (grant == 2'd1);
assign r2_rd_data_valid = dc_rd_data_valid && granted && (grant == 2'd2);

// Read ack
assign r0_rd_ack = dc_rd_ack && granted && (grant == 2'd0);
assign r1_rd_ack = dc_rd_ack && granted && (grant == 2'd1);
assign r2_rd_ack = dc_rd_ack && granted && (grant == 2'd2);

// Write ack
assign r0_wr_ack = dc_wr_ack && granted && (grant == 2'd0);
assign r1_wr_ack = dc_wr_ack && granted && (grant == 2'd1);
assign r2_wr_ack = dc_wr_ack && granted && (grant == 2'd2);

// Write busy
assign r0_wr_busy = dc_wr_busy;
assign r1_wr_busy = dc_wr_busy;
assign r2_wr_busy = dc_wr_busy;

endmodule
