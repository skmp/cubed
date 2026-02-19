//
// Gaussian lookup table for splat rasterizer.
//
// 2048 entries of u0.16 values: exp(-0.5 * i/256) * 65535
// Indexed by d² in u4.18 format, shifted right by 10: lut_idx = d2_sum >> 10
//
// Covers d² range [0, 8), cutoff at d² >= 8 (exp(-4) = 0.018, negligible).
// Uses ~4 M10K blocks on Cyclone V.
//

module gauss_lut (
	input         clk,
	input  [10:0] addr,    // 0..2047
	output [15:0] data     // u0.16 Gaussian value
);

(* ram_init_file = "rtl/gauss_lut.mif" *)
reg [15:0] lut [0:2047];

reg [15:0] data_r;
assign data = data_r;

always @(posedge clk) begin
	data_r <= lut[addr];
end

endmodule
