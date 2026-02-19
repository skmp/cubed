//
// DDRAM controller - manages read/write bursts to DDR3 via MiSTer Avalon-MM interface.
//
// Simple arbiter: one operation at a time. Reads have priority.
// Supports burst reads (up to 128 words) and burst writes.
//

module ddram_ctrl (
	input         clk,
	input         reset,

	// DDRAM physical interface
	output        ddram_clk,
	input         ddram_busy,
	output reg  [7:0] ddram_burstcnt,
	output reg [28:0] ddram_addr,
	input      [63:0] ddram_dout,
	input             ddram_dout_ready,
	output reg        ddram_rd,
	output reg [63:0] ddram_din,
	output reg  [7:0] ddram_be,
	output reg        ddram_we,

	// Read request channel
	input      [28:0] rd_addr,
	input        [7:0] rd_burstcnt,   // 1..128
	input              rd_req,
	output reg         rd_ack,        // pulses when request is accepted
	output      [63:0] rd_data,
	output             rd_data_valid,

	// Write request channel
	input      [28:0] wr_addr,
	input        [7:0] wr_burstcnt,   // 1..128
	input       [63:0] wr_data,
	input        [7:0] wr_be_in,
	input              wr_req,        // assert for each word in burst
	output reg         wr_ack,        // pulses when word is accepted
	output reg         wr_busy        // high while write burst in progress
);

assign ddram_clk = clk;
assign rd_data = ddram_dout;
assign rd_data_valid = ddram_dout_ready;

localparam S_IDLE      = 3'd0;
localparam S_RD_ISSUE  = 3'd1;
localparam S_RD_WAIT   = 3'd2;
localparam S_WR_ISSUE  = 3'd3;
localparam S_WR_DATA   = 3'd4;

reg [2:0] state;
reg [7:0] burst_remain;

always @(posedge clk) begin
	if (reset) begin
		state <= S_IDLE;
		ddram_rd <= 0;
		ddram_we <= 0;
		rd_ack <= 0;
		wr_ack <= 0;
		wr_busy <= 0;
		burst_remain <= 0;
	end else begin
		rd_ack <= 0;
		wr_ack <= 0;

		case (state)
		S_IDLE: begin
			ddram_rd <= 0;
			ddram_we <= 0;
			wr_busy <= 0;

			// Read has priority
			if (rd_req && !ddram_busy) begin
				state <= S_RD_ISSUE;
			end else if (wr_req && !ddram_busy) begin
				state <= S_WR_ISSUE;
			end
		end

		S_RD_ISSUE: begin
			if (!ddram_busy) begin
				ddram_addr     <= rd_addr;
				ddram_burstcnt <= rd_burstcnt;
				ddram_rd       <= 1;
				ddram_we       <= 0;
				ddram_be       <= 8'hFF;
				burst_remain   <= rd_burstcnt;
				rd_ack         <= 1;
				state          <= S_RD_WAIT;
			end
		end

		S_RD_WAIT: begin
			ddram_rd <= 0;  // deassert after 1 cycle
			if (ddram_dout_ready) begin
				burst_remain <= burst_remain - 8'd1;
				if (burst_remain == 8'd1) begin
					state <= S_IDLE;
				end
			end
		end

		S_WR_ISSUE: begin
			if (!ddram_busy) begin
				ddram_addr     <= wr_addr;
				ddram_burstcnt <= wr_burstcnt;
				ddram_din      <= wr_data;
				ddram_be       <= wr_be_in;
				ddram_we       <= 1;
				ddram_rd       <= 0;
				burst_remain   <= wr_burstcnt - 8'd1;
				wr_ack         <= 1;
				wr_busy        <= 1;
				if (wr_burstcnt == 8'd1)
					state <= S_IDLE;
				else
					state <= S_WR_DATA;
			end
		end

		S_WR_DATA: begin
			ddram_we <= 0;  // only first word has WE asserted with address
			if (!ddram_busy && wr_req) begin
				ddram_din  <= wr_data;
				ddram_be   <= wr_be_in;
				ddram_we   <= 1;
				wr_ack     <= 1;
				burst_remain <= burst_remain - 8'd1;
				if (burst_remain == 8'd1)
					state <= S_IDLE;
			end
		end

		default: state <= S_IDLE;
		endcase
	end
end

endmodule
