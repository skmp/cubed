//
// GSplat rasterizer core - processes a single tile.
//
// Architecture:
//   - Dual tile buffers (A/B): rasterizer writes to active buffer while
//     tile_writer flushes the inactive buffer to DDR3 in the background.
//   - Splat input FIFO (32-deep): decouples DDR3 burst reads from splat
//     consumption, enabling deeper prefetching.
//   - Unified S_PROCESS state: DDR3 read pump and rasterize pump run
//     concurrently. The read pump fills the FIFO, splat_reader drains it,
//     and the rasterizer processes splats as they become available.
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

localparam S_IDLE       = 3'd0;
localparam S_TILE_CLEAR = 3'd1;
localparam S_PROCESS    = 3'd2;  // read pump + rasterize pump
localparam S_TILE_FLUSH = 3'd3;  // start flush, then done
localparam S_DONE       = 3'd4;
localparam S_FLUSH_WAIT = 3'd5;  // wait for previous flush before starting new tile

reg [2:0] state;

// Latched tile parameters
reg [28:0] cur_tile_addr;
reg [15:0] cur_tile_px;
reg [15:0] cur_tile_py;
reg [31:0] cur_splat_count;

// Tile clear
reg  [9:0] clear_addr;

// ============================================================
// Splat input FIFO
// ============================================================

wire [63:0] fifo_rd_data;
wire        fifo_rd_valid;
wire        fifo_full;
wire  [5:0] fifo_count;
reg         fifo_flush;

// FIFO write: from DDR3 read data, gated to S_PROCESS for safety
// FIFO read: consumed by splat_reader via word_ready backpressure
wire fifo_wr_en = rd_data_valid && (state == S_PROCESS);

splat_fifo splat_fifo_inst (
	.clk(clk),
	.reset(reset),
	.wr_data(rd_data),
	.wr_en(fifo_wr_en),
	.full(fifo_full),
	.rd_data(fifo_rd_data),
	.rd_valid(fifo_rd_valid),
	.rd_ack(sr_word_ready & fifo_rd_valid),
	.count(fifo_count),
	.flush(fifo_flush)
);

// FIFO has room for a full burst (4 words) PLUS 4 in-flight words
// from a previous burst that was acked but whose data hasn't arrived yet.
// With 32-deep FIFO: 32 - 4 (new burst) - 4 (in-flight) = 24.
wire fifo_has_room = (fifo_count <= 6'd24);

// ============================================================
// Splat reader (fed from FIFO)
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
	.word_data(fifo_rd_data),
	.word_valid(fifo_rd_valid),
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
// Dual tile buffers
// ============================================================

reg active_buf;  // 0 = rasterizer uses A, writer uses B
                 // 1 = rasterizer uses B, writer uses A

// Buffer A
reg   [9:0] tb_A_rd_addr;
wire [63:0] tb_A_rd_data;
reg   [9:0] tb_A_wr_addr;
reg  [63:0] tb_A_wr_data;
reg         tb_A_wr_en;

tile_buffer tile_buffer_A (
	.clk(clk),
	.rd_addr(tb_A_rd_addr),
	.rd_data(tb_A_rd_data),
	.wr_addr(tb_A_wr_addr),
	.wr_data(tb_A_wr_data),
	.wr_en(tb_A_wr_en)
);

// Buffer B
reg   [9:0] tb_B_rd_addr;
wire [63:0] tb_B_rd_data;
reg   [9:0] tb_B_wr_addr;
reg  [63:0] tb_B_wr_data;
reg         tb_B_wr_en;

tile_buffer tile_buffer_B (
	.clk(clk),
	.rd_addr(tb_B_rd_addr),
	.rd_data(tb_B_rd_data),
	.wr_addr(tb_B_wr_addr),
	.wr_data(tb_B_wr_data),
	.wr_en(tb_B_wr_en)
);

// Muxed read data for rasterizer and tile_writer
wire [63:0] rast_tb_rd_data = active_buf ? tb_B_rd_data : tb_A_rd_data;
wire [63:0] tw_tb_rd_data   = active_buf ? tb_A_rd_data : tb_B_rd_data;

// ============================================================
// Tile rasterizer (wired to shadow registers)
// ============================================================

wire  [9:0] rast_tb_rd_addr;
wire  [9:0] rast_tb_wr_addr;
wire [63:0] rast_tb_wr_data;
wire        rast_tb_wr_en;

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
	.tb_rd_data(rast_tb_rd_data),
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
// Tile writer (latched parameters for background flush)
// ============================================================

wire        tw_done;
reg         tw_start;
wire  [9:0] tw_tb_rd_addr;

// Latched parameters for tile_writer (may differ from cur_tile_*)
reg  [15:0] tw_tile_px;
reg  [15:0] tw_tile_py;
reg  [28:0] tw_fb_base;

tile_writer tile_writer_inst (
	.clk(clk),
	.reset(reset),
	.start(tw_start),
	.done(tw_done),
	.tile_px(tw_tile_px),
	.tile_py(tw_tile_py),
	.fb_base(tw_fb_base),
	.tb_rd_addr(tw_tb_rd_addr),
	.tb_rd_data(tw_tb_rd_data),
	.wr_addr(wr_addr),
	.wr_burstcnt(wr_burstcnt),
	.wr_data(wr_data),
	.wr_be(wr_be),
	.wr_req(wr_req),
	.wr_ack(wr_ack),
	.wr_busy(wr_busy)
);

// Tile writer running state
reg tw_running;

// ============================================================
// Tile buffer mux - connect rasterizer and writer to their buffers
// ============================================================

// Rasterizer-side signals (clear or rasterize, always on active buffer)
reg  [9:0] rast_side_rd_addr;
reg  [9:0] rast_side_wr_addr;
reg [63:0] rast_side_wr_data;
reg        rast_side_wr_en;

always @(*) begin
	case (state)
	S_PROCESS: begin
		rast_side_rd_addr = rast_tb_rd_addr;
		rast_side_wr_addr = rast_tb_wr_addr;
		rast_side_wr_data = rast_tb_wr_data;
		rast_side_wr_en   = rast_tb_wr_en;
	end
	S_TILE_CLEAR: begin
		rast_side_rd_addr = 10'd0;
		rast_side_wr_addr = clear_addr;
		rast_side_wr_data = 64'd0;
		rast_side_wr_en   = 1'b1;
	end
	default: begin
		rast_side_rd_addr = 10'd0;
		rast_side_wr_addr = 10'd0;
		rast_side_wr_data = 64'd0;
		rast_side_wr_en   = 1'b0;
	end
	endcase
end

// Connect muxed signals to buffers based on active_buf
always @(*) begin
	if (active_buf == 1'b0) begin
		// Rasterizer -> buffer A, Writer -> buffer B
		tb_A_rd_addr = rast_side_rd_addr;
		tb_A_wr_addr = rast_side_wr_addr;
		tb_A_wr_data = rast_side_wr_data;
		tb_A_wr_en   = rast_side_wr_en;

		tb_B_rd_addr = tw_tb_rd_addr;
		tb_B_wr_addr = 10'd0;
		tb_B_wr_data = 64'd0;
		tb_B_wr_en   = 1'b0;
	end else begin
		// Rasterizer -> buffer B, Writer -> buffer A
		tb_B_rd_addr = rast_side_rd_addr;
		tb_B_wr_addr = rast_side_wr_addr;
		tb_B_wr_data = rast_side_wr_data;
		tb_B_wr_en   = rast_side_wr_en;

		tb_A_rd_addr = tw_tb_rd_addr;
		tb_A_wr_addr = 10'd0;
		tb_A_wr_data = 64'd0;
		tb_A_wr_en   = 1'b0;
	end
end

// ============================================================
// Read pump tracking
// ============================================================

reg [31:0] read_idx;       // next splat to request from DDR3
reg [31:0] rast_idx;       // next splat to rasterize (counts completions)
reg        rd_req_pending; // DDR3 read request issued but not yet acked
reg        rast_busy;      // rasterizer is active

// First splat_reader start needs to be pulsed once at the start
// of S_PROCESS. After that, splat_reader auto-restarts via sr_splat_valid.
reg        sr_first_started;

// Splat ready flag: set by sr_splat_valid, cleared when latched into shadow regs.
// Needed because sr_splat_valid is a 1-cycle pulse and the rasterizer may be busy.
reg        splat_ready;

// ============================================================
// Core FSM
// ============================================================

always @(posedge clk) begin
	if (reset) begin
		state        <= S_IDLE;
		busy         <= 0;
		tile_done    <= 0;
		rd_req       <= 0;
		sr_start     <= 0;
		rast_start   <= 0;
		tw_start     <= 0;
		tw_running   <= 0;
		active_buf   <= 0;
		fifo_flush   <= 0;
		rd_req_pending <= 0;
		rast_busy    <= 0;
		splat_ready  <= 0;
	end else begin
		tile_done  <= 0;
		sr_start   <= 0;
		rast_start <= 0;
		tw_start   <= 0;
		fifo_flush <= 0;

		// Track tile_writer completion (runs in background)
		if (tw_done)
			tw_running <= 0;

		// Track rasterizer completion
		if (rast_done)
			rast_busy <= 0;

		case (state)

		S_IDLE: begin
			busy <= 0;
			if (tile_start) begin
				busy            <= 1;
				cur_tile_addr   <= tile_addr;
				cur_tile_px     <= tile_px;
				cur_tile_py     <= tile_py;
				cur_splat_count <= tile_splat_count;
				clear_addr      <= 0;
				fifo_flush      <= 1;  // clear any stale FIFO data
				if (tw_running) begin
					// Previous flush still in progress - wait
					state <= S_FLUSH_WAIT;
				end else begin
					state <= S_TILE_CLEAR;
				end
			end
		end

		S_FLUSH_WAIT: begin
			// Wait for previous tile_writer to finish before clearing
			// the active buffer (which the writer might still be reading)
			if (!tw_running) begin
				clear_addr <= 0;
				state      <= S_TILE_CLEAR;
			end
		end

		S_TILE_CLEAR: begin
			clear_addr <= clear_addr + 10'd1;
			if (clear_addr == 10'd1023) begin
				read_idx         <= 0;
				rast_idx         <= 0;
				rd_req_pending   <= 0;
				sr_first_started <= 0;
				splat_ready      <= 0;
				rast_busy        <= 0;
				state            <= S_PROCESS;
			end
		end

		// ============================================================
		// S_PROCESS: concurrent read pump + rasterize pump
		// ============================================================
		S_PROCESS: begin

			// -- Read pump: DDR3 -> FIFO --

			// Track rd_ack
			if (rd_ack) begin
				rd_req         <= 0;
				rd_req_pending <= 0;
			end

			// Issue next burst read if possible
			if (!rd_req_pending && read_idx < cur_splat_count && fifo_has_room) begin
				rd_addr     <= cur_tile_addr + 29'd2 +
				               {read_idx[26:0], 2'b00};
				rd_burstcnt <= 8'd4;
				rd_req      <= 1;
				rd_req_pending <= 1;
				read_idx    <= read_idx + 32'd1;

				// Start splat_reader for the first splat
				if (!sr_first_started) begin
					sr_start         <= 1;
					sr_first_started <= 1;
				end
			end

			// FIFO write side is automatic (rd_data_valid -> fifo wr_en)

			// -- Track splat_reader output --
			// sr_splat_valid is a 1-cycle pulse. Capture it in splat_ready
			// so we don't miss it if the rasterizer is busy.
			if (sr_splat_valid)
				splat_ready <= 1;

			// -- Rasterize pump: splat_reader -> rasterizer --

			// When a splat is available and rasterizer is idle, consume it.
			// Use rast_done (just finished) or !rast_busy (already idle).
			if ((splat_ready || sr_splat_valid) && (rast_done || !rast_busy)) begin
				// Latch into shadow registers
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

				rast_start  <= 1;
				rast_busy   <= 1;
				splat_ready <= 0;
				rast_idx    <= rast_idx + 32'd1;

				// Start reading next splat from FIFO
				if (rast_idx + 32'd1 < cur_splat_count)
					sr_start <= 1;
			end

			// Check if all splats are rasterized
			// rast_done fires when the last splat completes.
			// rast_idx is already incremented when the splat was latched.
			if (rast_done && rast_idx >= cur_splat_count) begin
				rd_req <= 0;
				state  <= S_TILE_FLUSH;
			end

			// Handle zero-splat tiles
			if (cur_splat_count == 0) begin
				rd_req <= 0;
				state  <= S_TILE_FLUSH;
			end
		end

		// ============================================================
		// S_TILE_FLUSH: start background flush and signal done
		// ============================================================
		S_TILE_FLUSH: begin
			if (tw_running) begin
				// Previous flush still active - wait
				// (shouldn't normally happen with proper pipelining)
			end else begin
				// Latch parameters for tile_writer
				tw_tile_px  <= cur_tile_px;
				tw_tile_py  <= cur_tile_py;
				tw_fb_base  <= fb_base;
				tw_start    <= 1;
				tw_running  <= 1;

				// Toggle active buffer: rasterizer moves to the other buffer,
				// writer continues reading from the one we just filled
				active_buf <= ~active_buf;

				state <= S_DONE;
			end
		end

		S_DONE: begin
			tile_done <= 1;
			rd_req    <= 0;
			// Check for immediate re-dispatch (tile_start may arrive
			// while we're still in S_DONE, before S_IDLE sees it)
			if (tile_start) begin
				busy            <= 1;
				cur_tile_addr   <= tile_addr;
				cur_tile_px     <= tile_px;
				cur_tile_py     <= tile_py;
				cur_splat_count <= tile_splat_count;
				clear_addr      <= 0;
				fifo_flush      <= 1;
				if (tw_running) begin
					state <= S_FLUSH_WAIT;
				end else begin
					state <= S_TILE_CLEAR;
				end
			end else begin
				state <= S_IDLE;
			end
		end

		default: state <= S_IDLE;
		endcase
	end
end

endmodule
