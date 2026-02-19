//
// DDR3 arbiter - multiplexes N requestors onto a single ddram_ctrl.
//
// Parameterized for N_REQ requestors (default 5: coordinator + 4 cores).
//
// Policy: Round-robin grant at idle. Once granted, held until the
// entire transaction completes:
//   - Reads: held until all burst data words received (rd_data_valid count)
//   - Writes: held until wr_ack (single-word bursts only in this design)
//
// Read data is broadcast to all requestors but rd_data_valid is gated
// so only the granted requestor sees it.
//
// Port convention: per-requestor signals are packed flat.
//   Requestor i's rd_addr = req_rd_addr[i*29 +: 29]
//

module ddram_arbiter #(
	parameter N_REQ = 5
) (
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

	// Per-requestor read interface (packed)
	input  [N_REQ*29-1:0] req_rd_addr,
	input  [N_REQ*8-1:0]  req_rd_burstcnt,
	input  [N_REQ-1:0]    req_rd_req,
	output [N_REQ-1:0]    req_rd_ack,
	output [N_REQ*64-1:0] req_rd_data,
	output [N_REQ-1:0]    req_rd_data_valid,

	// Per-requestor write interface (packed)
	input  [N_REQ*29-1:0] req_wr_addr,
	input  [N_REQ*8-1:0]  req_wr_burstcnt,
	input  [N_REQ*64-1:0] req_wr_data,
	input  [N_REQ*8-1:0]  req_wr_be,
	input  [N_REQ-1:0]    req_wr_req,
	output [N_REQ-1:0]    req_wr_ack,
	output [N_REQ-1:0]    req_wr_busy
);

// ============================================================
// Grant FSM
// ============================================================

localparam GS_IDLE     = 2'd0;
localparam GS_RD_WAIT  = 2'd1;  // waiting for read burst data
localparam GS_WR_WAIT  = 2'd2;  // waiting for write ack

// Grant width: ceil(log2(N_REQ))
localparam GRANT_W = (N_REQ <= 2) ? 1 :
                     (N_REQ <= 4) ? 2 : 3;

reg [1:0] gstate;
reg [GRANT_W-1:0] grant;
reg [GRANT_W-1:0] last_grant;
reg [7:0] rd_burst_remain;

// Detect any pending request from each requestor
wire [N_REQ-1:0] any_req_vec = req_rd_req | req_wr_req;
wire any_req = |any_req_vec;

// Granted requestor's rd_req and burstcnt (live mux)
wire granted_rd_req = req_rd_req[grant];
wire [7:0] granted_rd_burstcnt = req_rd_burstcnt[grant*8 +: 8];

// Round-robin next grant selection
reg [GRANT_W-1:0] next_grant;
always @(*) begin
	next_grant = {GRANT_W{1'b0}};
	begin : rr_scan
		integer j;
		reg [GRANT_W:0] candidate;  // 1 extra bit to avoid overflow
		for (j = 1; j <= N_REQ; j = j + 1) begin
			// Wrap around: (last_grant + j) mod N_REQ
			candidate = {1'b0, last_grant} + j[GRANT_W:0];
			if (candidate >= N_REQ)
				candidate = candidate - N_REQ;
			if (any_req_vec[candidate[GRANT_W-1:0]]) begin
				next_grant = candidate[GRANT_W-1:0];
				disable rr_scan;
			end
		end
	end
end

always @(posedge clk) begin
	if (reset) begin
		gstate          <= GS_IDLE;
		grant           <= {GRANT_W{1'b0}};
		last_grant      <= {GRANT_W{1'b0}};
		rd_burst_remain <= 8'd0;
	end else begin
		case (gstate)
		GS_IDLE: begin
			if (any_req) begin
				grant <= next_grant;
				// Default to write wait, override if read
				gstate <= GS_WR_WAIT;
				if (req_rd_req[next_grant])
					gstate <= GS_RD_WAIT;
			end
		end

		GS_RD_WAIT: begin
			if (dc_rd_ack && dc_rd_data_valid) begin
				rd_burst_remain <= granted_rd_burstcnt - 8'd1;
				if (granted_rd_burstcnt == 8'd1) begin
					last_grant <= grant;
					gstate     <= GS_IDLE;
				end
			end else if (dc_rd_ack) begin
				rd_burst_remain <= granted_rd_burstcnt;
			end else if (dc_rd_data_valid) begin
				rd_burst_remain <= rd_burst_remain - 8'd1;
				if (rd_burst_remain == 8'd1) begin
					last_grant <= grant;
					gstate     <= GS_IDLE;
				end
			end
		end

		GS_WR_WAIT: begin
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

assign dc_rd_addr     = req_rd_addr[grant*29 +: 29];
assign dc_rd_burstcnt = req_rd_burstcnt[grant*8 +: 8];
assign dc_rd_req      = granted && req_rd_req[grant];

assign dc_wr_addr     = req_wr_addr[grant*29 +: 29];
assign dc_wr_burstcnt = req_wr_burstcnt[grant*8 +: 8];
assign dc_wr_data     = req_wr_data[grant*64 +: 64];
assign dc_wr_be       = req_wr_be[grant*8 +: 8];
assign dc_wr_req      = granted && req_wr_req[grant];

// ============================================================
// Demux upstream signals to granted requestor
// ============================================================

genvar i;
generate
	for (i = 0; i < N_REQ; i = i + 1) begin : demux
		assign req_rd_data[i*64 +: 64]  = dc_rd_data;
		assign req_rd_data_valid[i]      = dc_rd_data_valid && granted && (grant == i[GRANT_W-1:0]);
		assign req_rd_ack[i]             = dc_rd_ack && granted && (grant == i[GRANT_W-1:0]);
		assign req_wr_ack[i]             = dc_wr_ack && granted && (grant == i[GRANT_W-1:0]);
		assign req_wr_busy[i]            = dc_wr_busy;
	end
endgenerate

endmodule
