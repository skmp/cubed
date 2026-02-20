//
// Synchronous FIFO for splat DDR3 words.
//
// 32-entry deep, 64-bit wide. Uses ~1 M10K block on Cyclone V.
// Show-ahead (FWFT): rd_data is valid combinationally when rd_valid=1.
// Consumer asserts rd_ack to pop the current word.
//
// Implementation: simple ring buffer with wr_ptr/rd_ptr using an extra
// MSB for full/empty disambiguation. Storage is inferred as BRAM.
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

// Storage - uses ALM registers (not M10K) for combinational read
(* ramstyle = "logic" *)
reg [63:0] mem [0:DEPTH-1];

reg [AW:0] wr_ptr;  // extra MSB for full/empty
reg [AW:0] rd_ptr;

assign count    = wr_ptr - rd_ptr;
assign full     = (count == DEPTH[AW:0]);
assign rd_valid = (wr_ptr != rd_ptr);

// Show-ahead output register
// We maintain a prefetch register that always holds mem[rd_ptr].
// Updated on: reset, flush, write-to-empty, and read-ack (advance).
reg [63:0] rd_data_r;
assign rd_data = rd_data_r;

// Next read pointer after ack
wire [AW:0] rd_ptr_next = rd_ptr + 1;

always @(posedge clk) begin
	if (reset || flush) begin
		wr_ptr    <= 0;
		rd_ptr    <= 0;
		rd_data_r <= 64'd0;
	end else begin
		// Write side
		if (wr_en && !full) begin
			mem[wr_ptr[AW-1:0]] <= wr_data;
			wr_ptr <= wr_ptr + 1;
		end

		// Read side
		if (rd_ack && rd_valid) begin
			rd_ptr <= rd_ptr_next;
		end

		// Update prefetch register for show-ahead behavior
		// Priority: if reading and writing simultaneously, handle both
		if (rd_ack && rd_valid) begin
			// Popping current entry - show next
			// If write is also happening to the slot we're about to read,
			// we need to handle that, but writes go to wr_ptr which is
			// always ahead of rd_ptr_next (or equal if FIFO becomes empty)
			if (rd_ptr_next == wr_ptr && wr_en) begin
				// FIFO will be empty after pop, but a new write arrives
				rd_data_r <= wr_data;
			end else begin
				rd_data_r <= mem[rd_ptr_next[AW-1:0]];
			end
		end else if (!rd_valid && wr_en) begin
			// FIFO was empty, new write makes it non-empty
			// Show the just-written data immediately
			rd_data_r <= wr_data;
		end
	end
end

endmodule
