//
// GSplat top-level controller.
//
// Orchestrates the full rasterization pipeline:
//   1. Poll DDR3 control block for frame request
//   2. For each tile (20x15 = 300 tiles at 640x480):
//      a. Clear tile buffer
//      b. Stream all splats from DDR3, rasterize overlapping ones
//      c. Write completed tile to DDR3 framebuffer
//   3. Signal frame done
//

module gsplat_top (
	input         clk,
	input         reset,

	// DDRAM interface (directly to emu ports)
	output        ddram_clk,
	input         ddram_busy,
	output  [7:0] ddram_burstcnt,
	output [28:0] ddram_addr,
	input  [63:0] ddram_dout,
	input         ddram_dout_ready,
	output        ddram_rd,
	output [63:0] ddram_din,
	output  [7:0] ddram_be,
	output        ddram_we,

	// Status
	output reg    rendering
);

// ============================================================
// Parameters
// ============================================================

localparam SCREEN_W     = 640;
localparam SCREEN_H     = 480;
localparam TILE_W       = 32;
localparam TILE_H       = 32;
localparam TILES_X      = SCREEN_W / TILE_W;  // 20
localparam TILES_Y      = SCREEN_H / TILE_H;  // 15

// DDR3 addresses (byte_addr >> 3)
localparam [28:0] CTRL_ADDR  = 29'h06080000;  // 0x30400000 >> 3
localparam [28:0] SPLAT_BASE = 29'h06040000;  // 0x30200000 >> 3
localparam        SPLAT_QWORDS = 4;            // 32 bytes = 4 x 64-bit

// ============================================================
// Top-level FSM
// ============================================================

localparam S_IDLE           = 4'd0;
localparam S_POLL_REQ       = 4'd1;
localparam S_POLL_WAIT      = 4'd2;
localparam S_FRAME_START    = 4'd3;
localparam S_TILE_CLEAR     = 4'd4;
localparam S_SPLAT_READ_REQ = 4'd5;
localparam S_SPLAT_READ     = 4'd6;
localparam S_SPLAT_CHECK    = 4'd7;
localparam S_SPLAT_RAST     = 4'd8;
localparam S_TILE_FLUSH     = 4'd9;
localparam S_TILE_NEXT      = 4'd10;
localparam S_FRAME_DONE_WR  = 4'd11;
localparam S_FRAME_DONE     = 4'd12;

reg [3:0] state;

// Frame state
reg [15:0] splat_count;
reg [15:0] splat_idx;
reg  [4:0] tile_x;    // 0..TILES_X-1
reg  [4:0] tile_y;    // 0..TILES_Y-1
reg [15:0] tile_px;   // tile_x * TILE_W
reg [15:0] tile_py;   // tile_y * TILE_H
reg [15:0] tile_num;  // linear tile counter for progress tracking

// Tile clear state
reg  [9:0] clear_addr;

// Poll delay counter
reg [15:0] poll_delay;

// ============================================================
// DDRAM controller
// ============================================================

wire [28:0] dc_rd_addr;
wire  [7:0] dc_rd_burstcnt;
wire        dc_rd_req;
wire        dc_rd_ack;
wire [63:0] dc_rd_data;
wire        dc_rd_data_valid;

wire [28:0] dc_wr_addr;
wire  [7:0] dc_wr_burstcnt;
wire [63:0] dc_wr_data;
wire  [7:0] dc_wr_be;
wire        dc_wr_req;
wire        dc_wr_ack;
wire        dc_wr_busy;

ddram_ctrl ddram_ctrl_inst (
	.clk(clk),
	.reset(reset),
	.ddram_clk(ddram_clk),
	.ddram_busy(ddram_busy),
	.ddram_burstcnt(ddram_burstcnt),
	.ddram_addr(ddram_addr),
	.ddram_dout(ddram_dout),
	.ddram_dout_ready(ddram_dout_ready),
	.ddram_rd(ddram_rd),
	.ddram_din(ddram_din),
	.ddram_be(ddram_be),
	.ddram_we(ddram_we),

	.rd_addr(dc_rd_addr),
	.rd_burstcnt(dc_rd_burstcnt),
	.rd_req(dc_rd_req),
	.rd_ack(dc_rd_ack),
	.rd_data(dc_rd_data),
	.rd_data_valid(dc_rd_data_valid),

	.wr_addr(dc_wr_addr),
	.wr_burstcnt(dc_wr_burstcnt),
	.wr_data(dc_wr_data),
	.wr_be_in(dc_wr_be),
	.wr_req(dc_wr_req),
	.wr_ack(dc_wr_ack),
	.wr_busy(dc_wr_busy)
);

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
	.word_data(dc_rd_data),
	.word_valid(dc_rd_data_valid),
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

// Mux between rasterizer and writer/clear for tile buffer access
reg   [9:0] tb_rd_addr;
wire [63:0] tb_rd_data;
reg   [9:0] tb_wr_addr;
reg  [63:0] tb_wr_data;
reg         tb_wr_en;

// Rasterizer tile buffer interface
wire  [9:0] rast_tb_rd_addr;
wire  [9:0] rast_tb_wr_addr;
wire [63:0] rast_tb_wr_data;
wire        rast_tb_wr_en;

// Writer tile buffer interface
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
	.tile_px(tile_px),
	.tile_py(tile_py),
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

wire [28:0] tw_wr_addr;
wire  [7:0] tw_wr_burstcnt;
wire [63:0] tw_wr_data;
wire  [7:0] tw_wr_be;
wire        tw_wr_req;

tile_writer tile_writer_inst (
	.clk(clk),
	.reset(reset),
	.start(tw_start),
	.done(tw_done),
	.tile_px(tile_px),
	.tile_py(tile_py),
	.tb_rd_addr(tw_tb_rd_addr),
	.tb_rd_data(tb_rd_data),
	.wr_addr(tw_wr_addr),
	.wr_burstcnt(tw_wr_burstcnt),
	.wr_data(tw_wr_data),
	.wr_be(tw_wr_be),
	.wr_req(tw_wr_req),
	.wr_ack(dc_wr_ack),
	.wr_busy(dc_wr_busy)
);

// ============================================================
// DDRAM request mux
// ============================================================

// Read channel: used by top FSM (poll + splat reads)
reg  [28:0] top_rd_addr;
reg   [7:0] top_rd_burstcnt;
reg         top_rd_req;

assign dc_rd_addr     = top_rd_addr;
assign dc_rd_burstcnt = top_rd_burstcnt;
assign dc_rd_req      = top_rd_req;

// Write channel: mux between top FSM (frame_done ack) and tile_writer
reg         top_wr_req;
reg  [28:0] top_wr_addr;
reg  [63:0] top_wr_data;

wire use_tw_wr = (state == S_TILE_FLUSH);

assign dc_wr_addr     = use_tw_wr ? tw_wr_addr     : top_wr_addr;
assign dc_wr_burstcnt = use_tw_wr ? tw_wr_burstcnt : 8'd1;
assign dc_wr_data     = use_tw_wr ? tw_wr_data     : top_wr_data;
assign dc_wr_be       = use_tw_wr ? tw_wr_be       : 8'hFF;
assign dc_wr_req      = use_tw_wr ? tw_wr_req      : top_wr_req;

// Tile buffer mux: rasterizer during S_SPLAT_RAST, writer during S_TILE_FLUSH, top during clear
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
		// Clear or idle - top FSM controls writes
		tb_rd_addr = 10'd0;
		tb_wr_addr = clear_addr;
		tb_wr_data = 64'd0;
		tb_wr_en   = (state == S_TILE_CLEAR);
	end
	endcase
end

// ============================================================
// Main FSM
// ============================================================

// Latch for poll data
reg [63:0] poll_data;

always @(posedge clk) begin
	if (reset) begin
		state       <= S_IDLE;
		rendering   <= 0;
		top_rd_req  <= 0;
		top_wr_req  <= 0;
		sr_start    <= 0;
		rast_start  <= 0;
		tw_start    <= 0;
		poll_delay  <= 0;
	end else begin
		sr_start   <= 0;
		rast_start <= 0;
		tw_start   <= 0;
		top_rd_req <= 0;
		top_wr_req <= 0;

		case (state)

		// ---- Poll control block ----
		S_IDLE: begin
			rendering <= 0;
			// Delay between polls to avoid hammering DDR3
			if (poll_delay == 0) begin
				state <= S_POLL_REQ;
				poll_delay <= 16'd50000;  // ~1ms at 50MHz
			end else begin
				poll_delay <= poll_delay - 16'd1;
			end
		end

		S_POLL_REQ: begin
			// Read control block: word 0 = {frame_request[31:0], splat_count[31:0]}
			top_rd_addr     <= CTRL_ADDR;
			top_rd_burstcnt <= 8'd1;
			if (dc_rd_ack) begin
				top_rd_req <= 0;
				state <= S_POLL_WAIT;
			end else begin
				top_rd_req <= 1;
			end
		end

		S_POLL_WAIT: begin
			if (dc_rd_data_valid) begin
				poll_data <= dc_rd_data;
				// splat_count in [31:0], frame_request in [63:32]
				if (dc_rd_data[63:32] != 0 && dc_rd_data[15:0] != 0) begin
					splat_count <= dc_rd_data[15:0];
					state       <= S_FRAME_START;
				end else begin
					state <= S_IDLE;
				end
			end
		end

		// ---- Frame start ----
		S_FRAME_START: begin
			rendering <= 1;
			tile_x    <= 0;
			tile_y    <= 0;
			tile_px   <= 0;
			tile_py   <= 0;
			tile_num  <= 0;
			state     <= S_TILE_CLEAR;
			clear_addr <= 0;
		end

		// ---- Clear tile buffer ----
		S_TILE_CLEAR: begin
			// Write zeros to tile buffer, 1 entry per clock
			// tb_wr_en is driven by the mux (always 1 in this state)
			clear_addr <= clear_addr + 10'd1;
			if (clear_addr == 10'd1023) begin
				splat_idx <= 0;
				state     <= S_SPLAT_READ_REQ;
			end
		end

		// ---- Read one splat from DDR3 ----
		S_SPLAT_READ_REQ: begin
			if (splat_idx >= splat_count) begin
				// All splats processed for this tile
				state <= S_TILE_FLUSH;
				tw_start <= 1;
			end else begin
				// Request 4 words (32 bytes) for this splat
				top_rd_addr     <= SPLAT_BASE + {13'd0, splat_idx} * SPLAT_QWORDS;
				top_rd_burstcnt <= 8'd4;
				sr_start        <= 1;
				if (dc_rd_ack) begin
					top_rd_req <= 0;
					state <= S_SPLAT_READ;
				end else begin
					top_rd_req <= 1;
				end
			end
		end

		S_SPLAT_READ: begin
			// Wait for splat_reader to assemble all 4 words
			if (sr_splat_valid) begin
				state <= S_SPLAT_CHECK;
			end
		end

		// ---- Check bbox overlap ----
		S_SPLAT_CHECK: begin
			// Quick reject: does splat bbox overlap this tile?
			if (sr_bbox_x1 < $signed({1'b0, tile_px}) ||
			    sr_bbox_x0 >= $signed({1'b0, tile_px} + TILE_W) ||
			    sr_bbox_y1 < $signed({1'b0, tile_py}) ||
			    sr_bbox_y0 >= $signed({1'b0, tile_py} + TILE_H)) begin
				// No overlap, next splat
				splat_idx <= splat_idx + 16'd1;
				state     <= S_SPLAT_READ_REQ;
			end else begin
				// Overlap - rasterize
				rast_start <= 1;
				state      <= S_SPLAT_RAST;
			end
		end

		// ---- Rasterize splat into tile ----
		S_SPLAT_RAST: begin
			if (rast_done) begin
				splat_idx <= splat_idx + 16'd1;
				state     <= S_SPLAT_READ_REQ;
			end
		end

		// ---- Flush tile to DDR3 framebuffer ----
		S_TILE_FLUSH: begin
			if (tw_done) begin
				state <= S_TILE_NEXT;
			end
		end

		// ---- Advance to next tile ----
		S_TILE_NEXT: begin
			tile_num <= tile_num + 16'd1;
			if (tile_x + 1 >= TILES_X) begin
				tile_x  <= 0;
				tile_px <= 0;
				if (tile_y + 1 >= TILES_Y) begin
					// Frame complete
					state <= S_FRAME_DONE_WR;
				end else begin
					tile_y  <= tile_y + 5'd1;
					tile_py <= tile_py + TILE_H;
					clear_addr <= 0;
					state   <= S_TILE_CLEAR;
				end
			end else begin
				tile_x  <= tile_x + 5'd1;
				tile_px <= tile_px + TILE_W;
				clear_addr <= 0;
				state   <= S_TILE_CLEAR;
			end
		end

		// ---- Write frame done to control block ----
		S_FRAME_DONE_WR: begin
			// Write to second qword (bytes 8-15):
			//   [31:0]  = ctrl[2] = frame_done (byte offset 8)
			//   [63:32] = ctrl[3] = frame_number / tile count (byte offset 12)
			top_wr_addr <= CTRL_ADDR + 29'd1;  // byte offset 8 = qword offset 1
			top_wr_data <= {16'd0, tile_num, 32'd1};  // frame_done=1, frame_number=tile_num
			if (dc_wr_ack) begin
				top_wr_req <= 0;
				state <= S_FRAME_DONE;
			end else begin
				top_wr_req <= 1;
			end
		end

		S_FRAME_DONE: begin
			// Clear frame_request in control block word 0
			top_wr_addr <= CTRL_ADDR;
			top_wr_data <= {32'd0, {16'd0, splat_count}};  // frame_req=0, keep splat_count
			if (dc_wr_ack) begin
				top_wr_req <= 0;
				state <= S_IDLE;
			end else begin
				top_wr_req <= 1;
			end
		end

		default: state <= S_IDLE;
		endcase
	end
end

endmodule
