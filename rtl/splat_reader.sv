//
// Splat reader - unpacks splat_2d_t from 4 x 64-bit DDR3 words.
//
// Memory layout of splat_2d_t (32 bytes, little-endian):
//   Word 0: [31:0] = sx_fp (int32, s14.4), [63:32] = sy_fp (int32, s14.4)
//   Word 1: [31:0] = depth (float, ignored), [47:32] = cov_a_fp (u16, u2.14), [63:48] = cov_c_fp (u16, u2.14)
//   Word 2: [31:0] = cov_b2_fp (int32, s2.14), [39:32] = r, [47:40] = g, [55:48] = b, [63:56] = opacity
//   Word 3: [15:0] = bbox_x0, [31:16] = bbox_y0, [47:32] = bbox_x1, [63:48] = bbox_y1
//

module splat_reader (
	input         clk,
	input         reset,

	// Input: 64-bit words from DDR3 (or FIFO)
	input  [63:0] word_data,
	input         word_valid,
	output        word_ready,   // backpressure

	// Splat start/reset
	input         start,        // pulse to begin accumulating a new splat

	// Output: unpacked splat fields
	output reg signed [31:0] sx_fp,
	output reg signed [31:0] sy_fp,
	output reg        [15:0] cov_a_fp,
	output reg        [15:0] cov_c_fp,
	output reg signed [31:0] cov_b2_fp,
	output reg         [7:0] r,
	output reg         [7:0] g,
	output reg         [7:0] b,
	output reg         [7:0] opacity,
	output reg signed [15:0] bbox_x0,
	output reg signed [15:0] bbox_y0,
	output reg signed [15:0] bbox_x1,
	output reg signed [15:0] bbox_y1,
	output reg               splat_valid   // all fields valid
);

reg [1:0] word_idx;
reg       active;

assign word_ready = active;

always @(posedge clk) begin
	if (reset) begin
		word_idx    <= 0;
		active      <= 0;
		splat_valid <= 0;
	end else begin
		splat_valid <= 0;

		if (active && word_valid) begin
			case (word_idx)
			2'd0: begin
				sx_fp <= $signed(word_data[31:0]);
				sy_fp <= $signed(word_data[63:32]);
			end
			2'd1: begin
				// word_data[31:0] = depth (ignored)
				cov_a_fp <= word_data[47:32];
				cov_c_fp <= word_data[63:48];
			end
			2'd2: begin
				cov_b2_fp <= $signed(word_data[31:0]);
				r         <= word_data[39:32];
				g         <= word_data[47:40];
				b         <= word_data[55:48];
				opacity   <= word_data[63:56];
			end
			2'd3: begin
				bbox_x0     <= $signed(word_data[15:0]);
				bbox_y0     <= $signed(word_data[31:16]);
				bbox_x1     <= $signed(word_data[47:32]);
				bbox_y1     <= $signed(word_data[63:48]);
				splat_valid <= 1;
				active      <= 0;
			end
			endcase
			word_idx <= word_idx + 2'd1;
		end

		// start has higher priority than word consumption:
		// if start arrives on the same cycle as word_idx==3 completion,
		// active stays 1 (overrides active<=0) and word_idx resets to 0.
		if (start) begin
			word_idx <= 0;
			active   <= 1;
		end
	end
end

endmodule
