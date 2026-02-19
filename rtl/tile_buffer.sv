//
// Tile buffer - dual-port BRAM for 32x32 tile accumulation.
//
// Stores 1024 pixels (32x32), each pixel is 4 channels x 16 bits = 64 bits.
// Total: 1024 x 64 = 65536 bits = ~7 M10K blocks on Cyclone V.
//
// Port A: read (1-cycle latency)
// Port B: write (or clear)
//

module tile_buffer (
	input         clk,

	// Read port
	input   [9:0] rd_addr,     // 0..1023 = ty*32 + tx
	output [63:0] rd_data,     // {A[15:0], B[15:0], G[15:0], R[15:0]}

	// Write port
	input   [9:0] wr_addr,
	input  [63:0] wr_data,
	input         wr_en
);

reg [63:0] mem [0:1023];

reg [63:0] rd_data_r;
assign rd_data = rd_data_r;

always @(posedge clk) begin
	rd_data_r <= mem[rd_addr];
end

always @(posedge clk) begin
	if (wr_en)
		mem[wr_addr] <= wr_data;
end

endmodule
