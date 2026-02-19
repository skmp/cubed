//
// Tile rasterizer - evaluates Gaussian kernel and alpha-blends into tile buffer.
//
// Matches the C code in gsplat.c rasterize_splat_tile() exactly.
//
// Fixed-point chain:
//   dx, dy:     s14.4 (pixel offset in 1/16ths)
//   dx², dy²:   (dx*dx)>>4, ~17 bits unsigned
//   a, c:       u2.14 (16 bits)
//   2*b:        s2.14 (17 bits signed)
//   d²:         u4.18 (22 bits meaningful, stored in 32-bit)
//   Gauss LUT:  u0.16 (16 bits, 2048 entries)
//   w:          u0.7  (0..128, where 128 = 1.0)
//   tile_buf:   u0.10 per channel (0..1023)
//

module tile_rasterizer (
	input         clk,
	input         reset,

	// Splat parameters (from splat_reader)
	input  signed [31:0] sx_fp,
	input  signed [31:0] sy_fp,
	input         [15:0] cov_a_fp,    // u2.14
	input         [15:0] cov_c_fp,    // u2.14
	input  signed [31:0] cov_b2_fp,   // s2.14
	input          [7:0] r,
	input          [7:0] g,
	input          [7:0] b_in,
	input          [7:0] opacity,
	input  signed [15:0] bbox_x0,
	input  signed [15:0] bbox_y0,
	input  signed [15:0] bbox_x1,
	input  signed [15:0] bbox_y1,

	// Tile position (pixel coordinates of tile origin)
	input         [15:0] tile_px,
	input         [15:0] tile_py,

	// Control
	input                start,       // pulse to begin rasterizing this splat
	output reg           done,        // pulses when complete

	// Tile buffer interface
	output reg     [9:0] tb_rd_addr,
	input         [63:0] tb_rd_data,  // {A[15:0], B[15:0], G[15:0], R[15:0]}
	output reg     [9:0] tb_wr_addr,
	output reg    [63:0] tb_wr_data,
	output reg           tb_wr_en,

	// Gaussian LUT interface
	output reg    [10:0] lut_addr,
	input         [15:0] lut_data     // u0.16
);

// Parameters
localparam TILE_W = 32;
localparam TILE_H = 32;
localparam D2_CUTOFF = 32'sh00200000;  // 8 << 18 = 2097152

// States
localparam S_IDLE       = 4'd0;
localparam S_CLIP       = 4'd1;
localparam S_ROW_SETUP  = 4'd2;
localparam S_ROW_DY2    = 4'd3;   // compute dy² from dy_fp
localparam S_ROW_DX     = 4'd4;   // compute initial dx² and dxdy
localparam S_PIX_TERMS  = 4'd5;   // compute term_a, term_b, term_c
localparam S_PIX_CHECK  = 4'd6;   // sum + cutoff check + start reads
localparam S_PIX_WAIT   = 4'd7;   // wait for BRAM/LUT read latency
localparam S_PIX_WEIGHT = 4'd8;   // LUT result + weight calc
localparam S_PIX_BLEND  = 4'd9;   // blend + write + increment
localparam S_PIX_SKIP   = 4'd10;  // skipped pixel: just increment
localparam S_DONE       = 4'd11;

reg [3:0] state;

// Clipped bounds (relative to tile, 0..31)
reg [4:0] x0, y0, x1, y1;

// Current pixel position in tile
reg [4:0] tx, ty;

// Fixed-point working registers
reg signed [31:0] dx_fp;
reg signed [31:0] dy_fp;
reg signed [31:0] dx2_raw;
reg signed [31:0] dxdy_raw;
reg signed [31:0] dy2_s;
reg signed [47:0] term_c;

// DSP multiply results
reg signed [47:0] term_a;
reg signed [47:0] term_b;
reg signed [31:0] d2_sum_comb;

// Color scaled to u0.10
reg [9:0] cr, cg, cb;

// Weight registers
reg [7:0] w_reg;
reg [7:0] omw_reg;

// Pixel read data
reg [15:0] px_r, px_g, px_b, px_a;

always @(posedge clk) begin
	if (reset) begin
		state    <= S_IDLE;
		done     <= 0;
		tb_wr_en <= 0;
	end else begin
		done     <= 0;
		tb_wr_en <= 0;

		case (state)

		S_IDLE: begin
			if (start) begin
				state <= S_CLIP;
			end
		end

		S_CLIP: begin
			// Clip splat bbox to tile bounds
			begin
				reg signed [15:0] cx0, cy0, cx1, cy1;
				cx0 = bbox_x0 - $signed({1'b0, tile_px});
				cy0 = bbox_y0 - $signed({1'b0, tile_py});
				cx1 = bbox_x1 - $signed({1'b0, tile_px});
				cy1 = bbox_y1 - $signed({1'b0, tile_py});

				if (cx0 < 0) cx0 = 0;
				if (cy0 < 0) cy0 = 0;
				if (cx1 >= TILE_W) cx1 = TILE_W - 1;
				if (cy1 >= TILE_H) cy1 = TILE_H - 1;

				if (cx0 > cx1 || cy0 > cy1) begin
					done  <= 1;
					state <= S_IDLE;
				end else begin
					x0 <= cx0[4:0];
					y0 <= cy0[4:0];
					x1 <= cx1[4:0];
					y1 <= cy1[4:0];

					cr <= {r, 2'b00};
					cg <= {g, 2'b00};
					cb <= {b_in, 2'b00};

					ty <= cy0[4:0];
					state <= S_ROW_SETUP;
				end
			end
		end

		// -- Row setup: 3 cycles --

		S_ROW_SETUP: begin
			// Compute dy_fp = ((tile_py + ty) * 16 + 8) - sy_fp  [s14.4]
			dy_fp <= ($signed({1'b0, tile_py}) + $signed({11'b0, ty})) * 16 + 8 - sy_fp;
			state <= S_ROW_DY2;
		end

		S_ROW_DY2: begin
			// dy_fp is now valid. Compute dy²>>4.
			begin
				reg signed [63:0] dy2_full;
				dy2_full = dy_fp * dy_fp;
				dy2_s <= dy2_full[35:4];  // >>4, unsigned ~17 bits
			end

			// Compute initial dx_fp for first pixel in row
			dx_fp <= ($signed({1'b0, tile_px}) + $signed({11'b0, x0})) * 16 + 8 - sx_fp;

			tx    <= x0;
			state <= S_ROW_DX;
		end

		S_ROW_DX: begin
			// dy2_s and dx_fp are now valid.
			// Compute initial dx²_raw and dxdy_raw (full products, not shifted).
			begin
				reg signed [63:0] dx2_full, dxdy_full;
				dx2_full  = dx_fp * dx_fp;
				dxdy_full = dx_fp * dy_fp;
				dx2_raw   <= dx2_full[31:0];
				dxdy_raw  <= dxdy_full[31:0];
			end

			// Also compute term_c (row-invariant)
			term_c <= $signed({1'b0, cov_c_fp}) * dy2_s;

			state <= S_PIX_TERMS;
		end

		// -- Per-pixel pipeline: 4 cycles (or 2 for skip) --

		S_PIX_TERMS: begin
			// dx2_raw and dxdy_raw are valid.
			// Compute term_a and term_b.
			term_a <= $signed({1'b0, cov_a_fp}) * (dx2_raw >>> 4);
			term_b <= cov_b2_fp * (dxdy_raw >>> 4);
			state  <= S_PIX_CHECK;
		end

		S_PIX_CHECK: begin
			// term_a, term_b, term_c are valid.
			// Compute d² and check cutoff.
			begin
				reg signed [31:0] d2;
				d2 = term_a[31:0] + term_b[31:0] + term_c[31:0];

				if (d2 < 0 || d2 >= D2_CUTOFF) begin
					state <= S_PIX_SKIP;
				end else begin
					// Start LUT read and tile buffer read (both have 1-cycle latency,
					// but addresses are registered via NBA so data arrives 2 cycles later).
					// Issue addresses here, wait in S_PIX_WAIT, read data in S_PIX_WEIGHT.
					lut_addr <= d2[20:10];
					tb_rd_addr <= {ty, tx};

					d2_sum_comb <= d2;  // save for debug if needed
					state <= S_PIX_WAIT;
				end
			end
		end

		S_PIX_WAIT: begin
			// Wait 1 cycle for BRAM and LUT read latency.
			// Addresses were set (via NBA) in S_PIX_CHECK, became visible to
			// BRAM/LUT at start of this cycle, outputs will be valid next cycle.
			state <= S_PIX_WEIGHT;
		end

		S_PIX_WEIGHT: begin
			// LUT and tile_buf data now available (1-cycle read latency).
			// Read pixel from tile buffer.
			px_r <= tb_rd_data[15:0];
			px_g <= tb_rd_data[31:16];
			px_b <= tb_rd_data[47:32];
			px_a <= tb_rd_data[63:48];

			// Compute weight: w = (gauss * opacity) >> 17
			begin
				reg [23:0] w_raw;
				w_raw = ({8'd0, lut_data} * {16'd0, opacity}) >> 17;
				if (w_raw > 128) w_raw = 128;
				if (w_raw == 0) begin
					state <= S_PIX_SKIP;
				end else begin
					w_reg   <= w_raw[7:0];
					omw_reg <= 8'd128 - w_raw[7:0];
					state   <= S_PIX_BLEND;
				end
			end
		end

		S_PIX_BLEND: begin
			// Alpha blend all 4 channels and write.
			begin
				reg [17:0] new_r, new_g, new_b, new_a;

				// px_new = (color_10 * w + px_old * omw) >> 7
				new_r = ({8'd0, cr}  * {10'd0, w_reg} + {2'd0, px_r} * {10'd0, omw_reg}) >> 7;
				new_g = ({8'd0, cg}  * {10'd0, w_reg} + {2'd0, px_g} * {10'd0, omw_reg}) >> 7;
				new_b = ({8'd0, cb}  * {10'd0, w_reg} + {2'd0, px_b} * {10'd0, omw_reg}) >> 7;
				new_a = (18'd1020    * {10'd0, w_reg} + {2'd0, px_a} * {10'd0, omw_reg}) >> 7;

				tb_wr_addr <= {ty, tx};
				tb_wr_data <= {new_a[15:0], new_b[15:0], new_g[15:0], new_r[15:0]};
				tb_wr_en   <= 1;
			end

			// Incremental update and advance to next pixel
			dx2_raw  <= dx2_raw + (dx_fp <<< 5) + 256;
			dxdy_raw <= dxdy_raw + (dy_fp <<< 4);
			dx_fp    <= dx_fp + 16;

			if (tx == x1) begin
				if (ty == y1) begin
					state <= S_DONE;
				end else begin
					ty    <= ty + 5'd1;
					state <= S_ROW_SETUP;
				end
			end else begin
				tx    <= tx + 5'd1;
				state <= S_PIX_TERMS;
			end
		end

		S_PIX_SKIP: begin
			// Skipped pixel - just do incremental update
			dx2_raw  <= dx2_raw + (dx_fp <<< 5) + 256;
			dxdy_raw <= dxdy_raw + (dy_fp <<< 4);
			dx_fp    <= dx_fp + 16;

			if (tx == x1) begin
				if (ty == y1) begin
					state <= S_DONE;
				end else begin
					ty    <= ty + 5'd1;
					state <= S_ROW_SETUP;
				end
			end else begin
				tx    <= tx + 5'd1;
				state <= S_PIX_TERMS;
			end
		end

		S_DONE: begin
			done  <= 1;
			state <= S_IDLE;
		end

		default: state <= S_IDLE;
		endcase
	end
end

endmodule
