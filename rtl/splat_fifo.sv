//
// Synchronous FIFO for splat DDR3 words.
//
// 32-entry deep, 64-bit wide. Uses ALM registers for combinational read.
// Show-ahead (FWFT): rd_data is valid combinationally when rd_valid=1.
// Consumer asserts rd_ack to pop the current word.
//
// Implementation: simple ring buffer with wr_ptr/rd_ptr using an extra
// MSB for full/empty disambiguation. Combinational read from register array.
//

module splat_fifo (
	input         clk,
	input         reset,

	// Write side (from DDR3 read data)
	input  [63:0] wr_data,
	input         wr_en,
	output        full,

	// Read side (to splat_reader)
	output [63:0] rd_data,
	output        rd_valid,
	input         rd_ack,

	// Status
	output  [5:0] count,

	// Flush: reset pointers without full reset
	input         flush
);

localparam DEPTH = 32;
localparam AW    = 5;  // log2(DEPTH)

// Storage - ALM registers for combinational read
(* ramstyle = "logic" *)
reg [63:0] mem [0:DEPTH-1];

reg [AW:0] wr_ptr;  // extra MSB for full/empty
reg [AW:0] rd_ptr;

assign count    = wr_ptr - rd_ptr;
assign full     = (count == DEPTH[AW:0]);
assign rd_valid = (wr_ptr != rd_ptr);

// Direct combinational read - no bypass register needed
assign rd_data = mem[rd_ptr[AW-1:0]];

always @(posedge clk) begin
	if (reset || flush) begin
		wr_ptr <= 0;
		rd_ptr <= 0;
	end else begin
		// Write side
		if (wr_en && !full) begin
			mem[wr_ptr[AW-1:0]] <= wr_data;
			wr_ptr <= wr_ptr + 1;
		end

		// Read side
		if (rd_ack && rd_valid) begin
			rd_ptr <= rd_ptr + 1;
		end
	end
end

endmodule
