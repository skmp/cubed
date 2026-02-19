//
// GSplat rasterizer core - processes a single tile.
//
// The coordinator pre-reads tile descriptor headers and passes tile parameters.
// This core handles: clear tile buffer → read inline splats → rasterize → flush to DDR3.
//
// Instantiated twice for 2-core parallelism.
//

module gsplat_core (
	input         clk,
	input         reset,

	// Tile dispatch interface (from coordinator)
	input         tile_start,        // pulse: begin processing
	input  [28:0] tile_addr,         // tile descriptor DDR3 qword address
	input  [15:0] tile_px,           // tile origin X (from header)
	input  [15:0] tile_py,           // tile origin Y (from header)
	input  [15:0] tile_splat_count,  // number of inline splats
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

localparam S_IDLE           = 4'd0;
localparam S_TILE_CLEAR     = 4'd1;
localparam S_SPLAT_READ_REQ = 4'd2;
localparam S_SPLAT_READ     = 4'd3;
localparam S_SPLAT_RAST     = 4'd4;
localparam S_TILE_FLUSH     = 4'd5;
localparam S_DONE           = 4'd6;

reg [3:0] state;

// Latched tile parameters
reg [28:0] cur_tile_addr;
reg [15:0] cur_tile_px;
reg [15:0] cur_tile_py;
reg [15:0] cur_splat_count;
reg [15:0] splat_idx;

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
// Tile rasterizer
// ============================================================

wire [10:0] rast_lut_addr;
wire [15:0] rast_lut_data;
wire        rast_done;
reg         rast_start;

tile_rasterizer rasterizer_inst (
	.clk(clk),
	.reset(reset),
	.sx_fp(sr_sx_fp),
	.sy_fp(sr_sy_fp),
	.cov_a_fp(sr_cov_a_fp),
	.cov_c_fp(sr_cov_c_fp),
	.cov_b2_fp(sr_cov_b2_fp),
	.r(sr_r),
	.g(sr_g),
	.b_in(sr_b),
	.opacity(sr_opacity),
	.bbox_x0(sr_bbox_x0),
	.bbox_y0(sr_bbox_y0),
	.bbox_x1(sr_bbox_x1),
	.bbox_y1(sr_bbox_y1),
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
	S_SPLAT_RAST: begin
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
				               {11'd0, splat_idx, 2'b00};
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
				rast_start <= 1;
				state      <= S_SPLAT_RAST;
			end
		end

		S_SPLAT_RAST: begin
			if (rast_done) begin
				splat_idx <= splat_idx + 16'd1;
				state     <= S_SPLAT_READ_REQ;
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
