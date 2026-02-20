//
// Tile rasterizer - evaluates Gaussian kernel and alpha-blends into tile buffer.
//
// Pipelined architecture: 5-stage pixel pipeline processes one pixel per cycle.
// Outer FSM handles row setup (3 cycles) and pipeline drain at row boundaries.
//
// Pipeline stages:
//   Stage 1 (TERMS):  term_a = cov_a * (dx2>>4), term_b = cov_b2 * (dxdy>>4)
//   Stage 2 (CHECK):  d2 = term_a + term_b + term_c; cutoff; issue LUT+BRAM addr
//   Stage 3 (WAIT):   BRAM/LUT read latency cycle
//   Stage 4 (WEIGHT): read LUT+BRAM data, compute w = (gauss*opacity)>>17
//   Stage 5 (BLEND):  blend channels, write tile buffer
//
// No tile buffer RAW hazards: each pixel within a splat has unique (tx,ty).
// dx2/dxdy incremental updates are simple adds, computed in Stage 1 for next pixel.
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

// ============================================================
// Outer FSM states
// ============================================================

localparam OS_IDLE      = 3'd0;
localparam OS_CLIP      = 3'd1;
localparam OS_ROW_SETUP = 3'd2;
localparam OS_ROW_DY2   = 3'd3;
localparam OS_ROW_DX    = 3'd4;
localparam OS_PIPELINE  = 3'd5;  // feeding pixels into pipeline
localparam OS_DRAIN     = 3'd6;  // draining pipeline, no new pixels
localparam OS_DONE      = 3'd7;

reg [2:0] ostate;

// Clipped bounds (relative to tile, 0..31)
reg [4:0] x0, y0, x1, y1;

// Current pixel position in tile (for feeding into pipeline)
reg [4:0] tx, ty;

// Color scaled to u0.10
reg [9:0] cr, cg, cb;

// Row-invariant registers
reg signed [31:0] dy_fp;
reg signed [31:0] dy2_s;
reg signed [47:0] term_c;

// Incremental pixel state (updated every cycle in OS_PIPELINE)
reg signed [31:0] dx_fp;
reg signed [31:0] dx2_raw;
reg signed [31:0] dxdy_raw;

// Track whether last row is done (for drain -> done vs drain -> row_setup)
reg last_row;

// ============================================================
// Pipeline registers
// ============================================================

// Stage 1 -> Stage 2
reg        s1_valid;
reg [4:0]  s1_tx, s1_ty;
reg signed [47:0] s1_term_a, s1_term_b;

// Stage 2 -> Stage 3
reg        s2_valid;
reg [4:0]  s2_tx, s2_ty;
reg        s2_skip;

// Stage 3 -> Stage 4
reg        s3_valid;
reg [4:0]  s3_tx, s3_ty;
reg        s3_skip;

// Stage 4 -> Stage 5
reg        s4_valid;
reg [4:0]  s4_tx, s4_ty;
reg        s4_skip;
reg [7:0]  s4_w, s4_omw;
reg [15:0] s4_px_r, s4_px_g, s4_px_b, s4_px_a;

// Pipeline empty flag
wire pipeline_active = s1_valid | s2_valid | s3_valid | s4_valid;

always @(posedge clk) begin
	if (reset) begin
		ostate   <= OS_IDLE;
		done     <= 0;
		tb_wr_en <= 0;
		s1_valid <= 0;
		s2_valid <= 0;
		s3_valid <= 0;
		s4_valid <= 0;
	end else begin
		done     <= 0;
		tb_wr_en <= 0;

		// ============================================================
		// Stage 5: BLEND (consumes s4 registers)
		// Always runs - processes whatever s4 holds
		// ============================================================

		if (s4_valid && !s4_skip) begin
			begin
				reg [17:0] new_r, new_g, new_b, new_a;

				// px_new = (color_10 * w + px_old * omw) >> 7
				new_r = ({8'd0, cr}  * {10'd0, s4_w} + {2'd0, s4_px_r} * {10'd0, s4_omw}) >> 7;
				new_g = ({8'd0, cg}  * {10'd0, s4_w} + {2'd0, s4_px_g} * {10'd0, s4_omw}) >> 7;
				new_b = ({8'd0, cb}  * {10'd0, s4_w} + {2'd0, s4_px_b} * {10'd0, s4_omw}) >> 7;
				new_a = (18'd1020   * {10'd0, s4_w} + {2'd0, s4_px_a} * {10'd0, s4_omw}) >> 7;

				tb_wr_addr <= {s4_ty, s4_tx};
				tb_wr_data <= {new_a[15:0], new_b[15:0], new_g[15:0], new_r[15:0]};
				tb_wr_en   <= 1;
			end
		end

		// ============================================================
		// Stage 4: WEIGHT (consumes s3, reads LUT + tile buffer)
		// ============================================================

		s4_valid <= s3_valid;
		s4_tx    <= s3_tx;
		s4_ty    <= s3_ty;
		s4_skip  <= s3_skip;

		if (s3_valid && !s3_skip) begin
			begin
				reg [23:0] w_raw;
				w_raw = ({8'd0, lut_data} * {16'd0, opacity}) >> 17;
				if (w_raw > 128) w_raw = 128;
				if (w_raw == 0) begin
					s4_skip <= 1;
				end else begin
					s4_w   <= w_raw[7:0];
					s4_omw <= 8'd128 - w_raw[7:0];
				end
			end
			s4_px_r <= tb_rd_data[15:0];
			s4_px_g <= tb_rd_data[31:16];
			s4_px_b <= tb_rd_data[47:32];
			s4_px_a <= tb_rd_data[63:48];
		end

		// ============================================================
		// Stage 3: WAIT (pure pass-through for BRAM/LUT latency)
		// ============================================================

		s3_valid <= s2_valid;
		s3_tx    <= s2_tx;
		s3_ty    <= s2_ty;
		s3_skip  <= s2_skip;

		// ============================================================
		// Stage 2: CHECK (consumes s1, d2 sum + cutoff, issue reads)
		// ============================================================

		s2_valid <= s1_valid;
		s2_tx    <= s1_tx;
		s2_ty    <= s1_ty;

		if (s1_valid) begin
			begin
				reg signed [31:0] d2;
				d2 = s1_term_a[31:0] + s1_term_b[31:0] + term_c[31:0];

				if (d2 < 0 || d2 >= D2_CUTOFF) begin
					s2_skip <= 1;
				end else begin
					s2_skip    <= 0;
					lut_addr   <= d2[20:10];
					tb_rd_addr <= {s1_ty, s1_tx};
				end
			end
		end else begin
			s2_skip <= 1;
		end

		// ============================================================
		// Stage 1: TERMS (fed by outer FSM in OS_PIPELINE)
		// s1 registers are set by the outer FSM below.
		// When not in OS_PIPELINE, s1_valid is cleared.
		// ============================================================

		// Default: no new pixel entering Stage 1
		s1_valid <= 0;

		// ============================================================
		// Outer FSM
		// ============================================================

		case (ostate)

		OS_IDLE: begin
			if (start) begin
				ostate <= OS_CLIP;
			end
		end

		OS_CLIP: begin
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
					done   <= 1;
					ostate <= OS_IDLE;
				end else begin
					x0 <= cx0[4:0];
					y0 <= cy0[4:0];
					x1 <= cx1[4:0];
					y1 <= cy1[4:0];

					cr <= {r, 2'b00};
					cg <= {g, 2'b00};
					cb <= {b_in, 2'b00};

					ty <= cy0[4:0];
					ostate <= OS_ROW_SETUP;
				end
			end
		end

		// -- Row setup: 3 cycles (same as before) --

		OS_ROW_SETUP: begin
			// Compute dy_fp = ((tile_py + ty) * 16 + 8) - sy_fp  [s14.4]
			dy_fp <= ($signed({1'b0, tile_py}) + $signed({11'b0, ty})) * 16 + 8 - sy_fp;
			ostate <= OS_ROW_DY2;
		end

		OS_ROW_DY2: begin
			// dy_fp is now valid. Compute dy²>>4.
			begin
				reg signed [63:0] dy2_full;
				dy2_full = dy_fp * dy_fp;
				dy2_s <= dy2_full[35:4];  // >>4, unsigned ~17 bits
			end

			// Compute initial dx_fp for first pixel in row
			dx_fp <= ($signed({1'b0, tile_px}) + $signed({11'b0, x0})) * 16 + 8 - sx_fp;

			tx    <= x0;
			ostate <= OS_ROW_DX;
		end

		OS_ROW_DX: begin
			// dy2_s and dx_fp are now valid.
			// Compute initial dx²_raw and dxdy_raw.
			begin
				reg signed [63:0] dx2_full, dxdy_full;
				dx2_full  = dx_fp * dx_fp;
				dxdy_full = dx_fp * dy_fp;
				dx2_raw   <= dx2_full[31:0];
				dxdy_raw  <= dxdy_full[31:0];
			end

			// Compute term_c (row-invariant)
			term_c <= $signed({1'b0, cov_c_fp}) * dy2_s;

			ostate <= OS_PIPELINE;
		end

		// -- Pipelined pixel processing --

		OS_PIPELINE: begin
			// Feed one pixel into Stage 1
			s1_valid  <= 1;
			s1_tx     <= tx;
			s1_ty     <= ty;
			s1_term_a <= $signed({1'b0, cov_a_fp}) * (dx2_raw >>> 4);
			s1_term_b <= cov_b2_fp * (dxdy_raw >>> 4);

			// Incremental update for NEXT pixel
			dx2_raw  <= dx2_raw + (dx_fp <<< 5) + 256;
			dxdy_raw <= dxdy_raw + (dy_fp <<< 4);
			dx_fp    <= dx_fp + 16;

			if (tx == x1) begin
				// End of row - stop feeding, drain pipeline
				if (ty == y1) begin
					last_row <= 1;
					ostate   <= OS_DRAIN;
				end else begin
					last_row <= 0;
					ty       <= ty + 5'd1;
					ostate   <= OS_ROW_SETUP;
					// Pipeline continues draining during row setup.
					// Row setup takes 3 cycles (SETUP, DY2, DX).
					// Pipeline drains in 4 cycles (s1..s4 flush out).
					// After OS_ROW_DX we go to OS_PIPELINE again.
				end
			end else begin
				tx <= tx + 5'd1;
			end
		end

		OS_DRAIN: begin
			// No new pixels. Wait for pipeline to empty.
			if (!pipeline_active) begin
				ostate <= OS_DONE;
			end
		end

		OS_DONE: begin
			done   <= 1;
			ostate <= OS_IDLE;
		end

		default: ostate <= OS_IDLE;
		endcase
	end
end

endmodule
