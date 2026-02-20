//
// GSplat rasterizer core - processes a single tile.
//
// The coordinator pre-reads tile descriptor headers and passes tile parameters.
// This core handles: clear tile buffer -> read inline splats -> rasterize -> flush to DDR3.
//
// Splat prefetching: DDR3 read of splat N+1 overlaps with rasterization of splat N.
// Shadow registers decouple the splat_reader from the rasterizer so the reader
// can begin receiving the next splat while the current one is being processed.
//

module gsplat_core (
	input         clk,
	input         reset,

	// Tile dispatch interface (from coordinator)
	input         tile_start,        // pulse: begin processing
	input  [28:0] tile_addr,         // tile descriptor DDR3 qword address
	input  [15:0] tile_px,           // tile origin X (from header)
	input  [15:0] tile_py,           // tile origin Y (from header)
	input  [31:0] tile_splat_count,  // number of inline splats
	input  [28:0] fb_base,           // framebuffer DDR3 qword base address

	// Status (to coordinator)
	output reg    tile_done,         // pulse: tile complete
	output reg    busy,              // high while processing

	// DDR3 read interface
	output reg [28:0] rd_addr,
	output reg  [7:0] rd_burstcnt,
	output reg        rd_req,
	input             rd_ack,
	input      [63:0] rd_data,
	input             rd_data_valid,

	// DDR3 write interface
	output     [28:0] wr_addr,
	output      [7:0] wr_burstcnt,
	output     [63:0] wr_data,
	output      [7:0] wr_be,
	output            wr_req,
	input             wr_ack,
	input             wr_busy
);

// ============================================================
// FSM
// ============================================================

localparam S_IDLE              = 4'd0;
localparam S_TILE_CLEAR        = 4'd1;
localparam S_SPLAT_READ_REQ    = 4'd2;
localparam S_SPLAT_READ        = 4'd3;
localparam S_SPLAT_RAST        = 4'd4;
localparam S_TILE_FLUSH        = 4'd5;
localparam S_DONE              = 4'd6;
localparam S_SPLAT_RAST_PREFETCH = 4'd7;  // rasterizing + prefetching next

reg [3:0] state;

// Latched tile parameters
reg [28:0] cur_tile_addr;
reg [15:0] cur_tile_px;
reg [15:0] cur_tile_py;
reg [31:0] cur_splat_count;
reg [31:0] splat_idx;

// Tile clear
reg  [9:0] clear_addr;

// ============================================================
// Splat reader
// ============================================================

wire        sr_word_ready;
wire signed [31:0] sr_sx_fp, sr_sy_fp;
wire        [15:0] sr_cov_a_fp, sr_cov_c_fp;
wire signed [31:0] sr_cov_b2_fp;
wire         [7:0] sr_r, sr_g, sr_b, sr_opacity;
wire signed [15:0] sr_bbox_x0, sr_bbox_y0, sr_bbox_x1, sr_bbox_y1;
wire               sr_splat_valid;
reg                sr_start;

splat_reader splat_reader_inst (
	.clk(clk),
	.reset(reset),
	.word_data(rd_data),
	.word_valid(rd_data_valid),
	.word_ready(sr_word_ready),
	.start(sr_start),
	.sx_fp(sr_sx_fp),
	.sy_fp(sr_sy_fp),
	.cov_a_fp(sr_cov_a_fp),
	.cov_c_fp(sr_cov_c_fp),
	.cov_b2_fp(sr_cov_b2_fp),
	.r(sr_r),
	.g(sr_g),
	.b(sr_b),
	.opacity(sr_opacity),
	.bbox_x0(sr_bbox_x0),
	.bbox_y0(sr_bbox_y0),
	.bbox_x1(sr_bbox_x1),
	.bbox_y1(sr_bbox_y1),
	.splat_valid(sr_splat_valid)
);

// ============================================================
// Shadow registers (decouple splat_reader from rasterizer)
// ============================================================

reg signed [31:0] rast_sx_fp, rast_sy_fp;
reg        [15:0] rast_cov_a_fp, rast_cov_c_fp;
reg signed [31:0] rast_cov_b2_fp;
reg         [7:0] rast_r, rast_g, rast_b, rast_opacity;
reg signed [15:0] rast_bbox_x0, rast_bbox_y0, rast_bbox_x1, rast_bbox_y1;

// ============================================================
// Tile buffer
// ============================================================

reg   [9:0] tb_rd_addr;
wire [63:0] tb_rd_data;
reg   [9:0] tb_wr_addr;
reg  [63:0] tb_wr_data;
reg         tb_wr_en;

wire  [9:0] rast_tb_rd_addr;
wire  [9:0] rast_tb_wr_addr;
wire [63:0] rast_tb_wr_data;
wire        rast_tb_wr_en;

wire  [9:0] tw_tb_rd_addr;

tile_buffer tile_buffer_inst (
	.clk(clk),
	.rd_addr(tb_rd_addr),
	.rd_data(tb_rd_data),
	.wr_addr(tb_wr_addr),
	.wr_data(tb_wr_data),
	.wr_en(tb_wr_en)
);

// ============================================================
// Tile rasterizer (wired to shadow registers)
// ============================================================

wire [10:0] rast_lut_addr;
wire [15:0] rast_lut_data;
wire        rast_done;
reg         rast_start;

tile_rasterizer rasterizer_inst (
	.clk(clk),
	.reset(reset),
	.sx_fp(rast_sx_fp),
	.sy_fp(rast_sy_fp),
	.cov_a_fp(rast_cov_a_fp),
	.cov_c_fp(rast_cov_c_fp),
	.cov_b2_fp(rast_cov_b2_fp),
	.r(rast_r),
	.g(rast_g),
	.b_in(rast_b),
	.opacity(rast_opacity),
	.bbox_x0(rast_bbox_x0),
	.bbox_y0(rast_bbox_y0),
	.bbox_x1(rast_bbox_x1),
	.bbox_y1(rast_bbox_y1),
	.tile_px(cur_tile_px),
	.tile_py(cur_tile_py),
	.start(rast_start),
	.done(rast_done),
	.tb_rd_addr(rast_tb_rd_addr),
	.tb_rd_data(tb_rd_data),
	.tb_wr_addr(rast_tb_wr_addr),
	.tb_wr_data(rast_tb_wr_data),
	.tb_wr_en(rast_tb_wr_en),
	.lut_addr(rast_lut_addr),
	.lut_data(rast_lut_data)
);

// ============================================================
// Gaussian LUT
// ============================================================

gauss_lut gauss_lut_inst (
	.clk(clk),
	.addr(rast_lut_addr),
	.data(rast_lut_data)
);

// ============================================================
// Tile writer
// ============================================================

wire        tw_done;
reg         tw_start;

tile_writer tile_writer_inst (
	.clk(clk),
	.reset(reset),
	.start(tw_start),
	.done(tw_done),
	.tile_px(cur_tile_px),
	.tile_py(cur_tile_py),
	.fb_base(fb_base),
	.tb_rd_addr(tw_tb_rd_addr),
	.tb_rd_data(tb_rd_data),
	.wr_addr(wr_addr),
	.wr_burstcnt(wr_burstcnt),
	.wr_data(wr_data),
	.wr_be(wr_be),
	.wr_req(wr_req),
	.wr_ack(wr_ack),
	.wr_busy(wr_busy)
);

// ============================================================
// Tile buffer mux
// ============================================================

always @(*) begin
	case (state)
	S_SPLAT_RAST, S_SPLAT_RAST_PREFETCH: begin
		tb_rd_addr = rast_tb_rd_addr;
		tb_wr_addr = rast_tb_wr_addr;
		tb_wr_data = rast_tb_wr_data;
		tb_wr_en   = rast_tb_wr_en;
	end
	S_TILE_FLUSH: begin
		tb_rd_addr = tw_tb_rd_addr;
		tb_wr_addr = 10'd0;
		tb_wr_data = 64'd0;
		tb_wr_en   = 1'b0;
	end
	default: begin
		tb_rd_addr = 10'd0;
		tb_wr_addr = clear_addr;
		tb_wr_data = 64'd0;
		tb_wr_en   = (state == S_TILE_CLEAR);
	end
	endcase
end

// ============================================================
// Prefetch tracking
// ============================================================

reg prefetch_read_done;   // next splat data has been fully read
reg prefetch_rd_issued;   // DDR3 read request has been acknowledged

// ============================================================
// Core FSM
// ============================================================

always @(posedge clk) begin
	if (reset) begin
		state      <= S_IDLE;
		busy       <= 0;
		tile_done  <= 0;
		rd_req     <= 0;
		sr_start   <= 0;
		rast_start <= 0;
		tw_start   <= 0;
	end else begin
		tile_done  <= 0;
		sr_start   <= 0;
		rast_start <= 0;
		tw_start   <= 0;
		rd_req     <= 0;

		case (state)

		S_IDLE: begin
			busy <= 0;
			if (tile_start) begin
				busy           <= 1;
				cur_tile_addr  <= tile_addr;
				cur_tile_px    <= tile_px;
				cur_tile_py    <= tile_py;
				cur_splat_count <= tile_splat_count;
				clear_addr     <= 0;
				state          <= S_TILE_CLEAR;
			end
		end

		S_TILE_CLEAR: begin
			clear_addr <= clear_addr + 10'd1;
			if (clear_addr == 10'd1023) begin
				splat_idx <= 0;
				state     <= S_SPLAT_READ_REQ;
			end
		end

		S_SPLAT_READ_REQ: begin
			if (splat_idx >= cur_splat_count) begin
				state <= S_TILE_FLUSH;
				tw_start <= 1;
			end else begin
				// Inline splats start at tile_addr + 2, each is 4 qwords
				rd_addr     <= cur_tile_addr + 29'd2 +
				               {splat_idx[26:0], 2'b00};
				rd_burstcnt <= 8'd4;
				sr_start    <= 1;
				if (rd_ack) begin
					rd_req <= 0;
					state  <= S_SPLAT_READ;
				end else begin
					rd_req <= 1;
				end
			end
		end

		S_SPLAT_READ: begin
			if (sr_splat_valid) begin
				// Latch splat data into shadow registers
				rast_sx_fp     <= sr_sx_fp;
				rast_sy_fp     <= sr_sy_fp;
				rast_cov_a_fp  <= sr_cov_a_fp;
				rast_cov_c_fp  <= sr_cov_c_fp;
				rast_cov_b2_fp <= sr_cov_b2_fp;
				rast_r         <= sr_r;
				rast_g         <= sr_g;
				rast_b         <= sr_b;
				rast_opacity   <= sr_opacity;
				rast_bbox_x0   <= sr_bbox_x0;
				rast_bbox_y0   <= sr_bbox_y0;
				rast_bbox_x1   <= sr_bbox_x1;
				rast_bbox_y1   <= sr_bbox_y1;

				rast_start <= 1;
				splat_idx  <= splat_idx + 32'd1;

				// Start prefetch of next splat if available
				if (splat_idx + 32'd1 < cur_splat_count) begin
					rd_addr     <= cur_tile_addr + 29'd2 +
					               {(splat_idx[26:0] + 27'd1), 2'b00};
					rd_burstcnt <= 8'd4;
					sr_start    <= 1;
					rd_req      <= 1;
					prefetch_read_done <= 0;
					prefetch_rd_issued <= 0;
					state <= S_SPLAT_RAST_PREFETCH;
				end else begin
					state <= S_SPLAT_RAST;
				end
			end
		end

		S_SPLAT_RAST: begin
			// No prefetch - just wait for rasterizer
			if (rast_done) begin
				state <= S_SPLAT_READ_REQ;
			end
		end

		S_SPLAT_RAST_PREFETCH: begin
			// Rasterizing current splat AND reading next splat simultaneously.
			// DDR3 read port is free during rasterization (rasterizer uses BRAM only).

			// Track DDR3 read acknowledgement
			if (rd_ack) begin
				rd_req <= 0;
				prefetch_rd_issued <= 1;
			end else if (!prefetch_rd_issued) begin
				rd_req <= 1;  // keep requesting until ack
			end

			// Track splat reader completion
			if (sr_splat_valid)
				prefetch_read_done <= 1;

			// Wait for both rasterizer done AND prefetch read done
			if (rast_done) begin
				if (prefetch_read_done || sr_splat_valid) begin
					// Next splat is ready - latch and start immediately
					rast_sx_fp     <= sr_sx_fp;
					rast_sy_fp     <= sr_sy_fp;
					rast_cov_a_fp  <= sr_cov_a_fp;
					rast_cov_c_fp  <= sr_cov_c_fp;
					rast_cov_b2_fp <= sr_cov_b2_fp;
					rast_r         <= sr_r;
					rast_g         <= sr_g;
					rast_b         <= sr_b;
					rast_opacity   <= sr_opacity;
					rast_bbox_x0   <= sr_bbox_x0;
					rast_bbox_y0   <= sr_bbox_y0;
					rast_bbox_x1   <= sr_bbox_x1;
					rast_bbox_y1   <= sr_bbox_y1;

					rast_start <= 1;
					splat_idx  <= splat_idx + 32'd1;

					// Continue prefetching if more splats
					if (splat_idx + 32'd1 < cur_splat_count) begin
						rd_addr     <= cur_tile_addr + 29'd2 +
						               {(splat_idx[26:0] + 27'd1), 2'b00};
						rd_burstcnt <= 8'd4;
						sr_start    <= 1;
						rd_req      <= 1;
						prefetch_read_done <= 0;
						prefetch_rd_issued <= 0;
						// stay in S_SPLAT_RAST_PREFETCH
					end else begin
						state <= S_SPLAT_RAST;  // last splat, no more prefetch
					end
				end else begin
					// Rasterizer done but read not yet complete.
					// Only safe to go to S_SPLAT_READ if the DDR3 read was
					// already acknowledged. Otherwise stay here to keep
					// asserting rd_req until the arbiter grants it.
					if (prefetch_rd_issued)
						state <= S_SPLAT_READ;
					// else: stay in S_SPLAT_RAST_PREFETCH, rd_req stays asserted
				end
			end
		end

		S_TILE_FLUSH: begin
			if (tw_done) begin
				state <= S_DONE;
			end
		end

		S_DONE: begin
			tile_done <= 1;
			state     <= S_IDLE;
		end

		default: state <= S_IDLE;
		endcase
	end
end

endmodule
