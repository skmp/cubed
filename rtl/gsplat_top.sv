//
// GSplat top-level coordinator - 2-core architecture with dual buffering.
//
// Orchestrates two gsplat_core instances processing tiles in parallel:
//   1. Poll DDR3 control block for frame request
//   2. Pre-read tile descriptor headers from linked list
//   3. Dispatch tiles to idle cores (pass tile_addr + header data)
//   4. When all tiles done, wait for vblank, swap FB, signal frame_done
//
// DDR3 access is arbitrated by ddram_arbiter (3 requestors:
// coordinator + core0 + core1).
//
// Dual buffering: FPGA renders to back buffer, swaps FB_BASE on vblank.
// MiSTer ascal latches FB_BASE on VS falling edge, so updating during
// vblank is race-free.
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

	// Framebuffer control (directly to emu FB ports)
	input         fb_vbl,          // vblank active (from ascal)
	output reg [31:0] fb_base_addr,   // framebuffer base address (byte)

	// Status
	output reg    rendering
);

// ============================================================
// Parameters
// ============================================================

localparam [28:0] CTRL_ADDR  = 29'h06080000;  // 0x30400000 >> 3
localparam [28:0] FB_A_QADDR = 29'h06000000;  // 0x30000000 >> 3
localparam [28:0] FB_B_QADDR = 29'h06040000;  // 0x30200000 >> 3
localparam [31:0] FB_A_BYTE  = 32'h30000000;
localparam [31:0] FB_B_BYTE  = 32'h30200000;

// ============================================================
// Coordinator FSM states
// ============================================================

localparam S_IDLE          = 4'd0;
localparam S_POLL_REQ      = 4'd1;
localparam S_POLL_WAIT     = 4'd2;
localparam S_FRAME_START   = 4'd3;
localparam S_DISPATCH      = 4'd4;   // check for idle core, dispatch or wait
localparam S_HDR_REQ       = 4'd5;   // read 2-qword tile header
localparam S_HDR_WAIT      = 4'd6;   // wait for header data
localparam S_HDR_DISPATCH  = 4'd7;   // send tile to core
localparam S_VBLANK_WAIT   = 4'd8;   // wait for vblank before swapping FB
localparam S_FRAME_DONE_WR = 4'd9;
localparam S_FRAME_DONE    = 4'd10;

reg [3:0] state;

// Frame state
reg [28:0] first_tile_addr;
reg [28:0] cur_tile_addr;    // next tile to dispatch
reg [15:0] tile_num;         // progress counter
reg        tiles_remaining;  // 0 when cur_tile_addr == 0

// Dual buffering
reg        back_buf;         // 0=render to A, 1=render to B
wire [28:0] render_fb_base = back_buf ? FB_B_QADDR : FB_A_QADDR;

// Header read state
reg        hdr_word_cnt;
reg [63:0] hdr_word0;
reg [15:0] hdr_tile_px;
reg [15:0] hdr_tile_py;
reg [15:0] hdr_splat_count;
reg [28:0] hdr_next_addr;

// Which core to dispatch to
reg        dispatch_core;    // 0 or 1

// Dispatch tracking - prevents re-dispatching before core sees tile_start
reg        c0_dispatched;
reg        c1_dispatched;
wire       c0_idle = !c0_busy && !c0_dispatched;
wire       c1_idle = !c1_busy && !c1_dispatched;

// Poll delay
reg [15:0] poll_delay;

// ============================================================
// DDRAM controller (single instance, shared)
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
// Coordinator DDR3 interface (requestor 0 for arbiter)
// ============================================================

reg  [28:0] coord_rd_addr;
reg   [7:0] coord_rd_burstcnt;
reg         coord_rd_req;
wire        coord_rd_ack;
wire [63:0] coord_rd_data;
wire        coord_rd_data_valid;

reg  [28:0] coord_wr_addr;
reg   [7:0] coord_wr_burstcnt;
reg  [63:0] coord_wr_data;
reg   [7:0] coord_wr_be;
reg         coord_wr_req;
wire        coord_wr_ack;
wire        coord_wr_busy;

// ============================================================
// Core 0
// ============================================================

wire        c0_tile_done;
wire        c0_busy;
reg         c0_tile_start;
reg  [28:0] c0_tile_addr;
reg  [15:0] c0_tile_px;
reg  [15:0] c0_tile_py;
reg  [15:0] c0_splat_count;

wire [28:0] c0_rd_addr;
wire  [7:0] c0_rd_burstcnt;
wire        c0_rd_req;
wire        c0_rd_ack;
wire [63:0] c0_rd_data;
wire        c0_rd_data_valid;

wire [28:0] c0_wr_addr;
wire  [7:0] c0_wr_burstcnt;
wire [63:0] c0_wr_data;
wire  [7:0] c0_wr_be;
wire        c0_wr_req;
wire        c0_wr_ack;
wire        c0_wr_busy;

gsplat_core core0 (
	.clk(clk),
	.reset(reset),
	.tile_start(c0_tile_start),
	.tile_addr(c0_tile_addr),
	.tile_px(c0_tile_px),
	.tile_py(c0_tile_py),
	.tile_splat_count(c0_splat_count),
	.fb_base(render_fb_base),
	.tile_done(c0_tile_done),
	.busy(c0_busy),
	.rd_addr(c0_rd_addr),
	.rd_burstcnt(c0_rd_burstcnt),
	.rd_req(c0_rd_req),
	.rd_ack(c0_rd_ack),
	.rd_data(c0_rd_data),
	.rd_data_valid(c0_rd_data_valid),
	.wr_addr(c0_wr_addr),
	.wr_burstcnt(c0_wr_burstcnt),
	.wr_data(c0_wr_data),
	.wr_be(c0_wr_be),
	.wr_req(c0_wr_req),
	.wr_ack(c0_wr_ack),
	.wr_busy(c0_wr_busy)
);

// ============================================================
// Core 1
// ============================================================

wire        c1_tile_done;
wire        c1_busy;
reg         c1_tile_start;
reg  [28:0] c1_tile_addr;
reg  [15:0] c1_tile_px;
reg  [15:0] c1_tile_py;
reg  [15:0] c1_splat_count;

wire [28:0] c1_rd_addr;
wire  [7:0] c1_rd_burstcnt;
wire        c1_rd_req;
wire        c1_rd_ack;
wire [63:0] c1_rd_data;
wire        c1_rd_data_valid;

wire [28:0] c1_wr_addr;
wire  [7:0] c1_wr_burstcnt;
wire [63:0] c1_wr_data;
wire  [7:0] c1_wr_be;
wire        c1_wr_req;
wire        c1_wr_ack;
wire        c1_wr_busy;

gsplat_core core1 (
	.clk(clk),
	.reset(reset),
	.tile_start(c1_tile_start),
	.tile_addr(c1_tile_addr),
	.tile_px(c1_tile_px),
	.tile_py(c1_tile_py),
	.tile_splat_count(c1_splat_count),
	.fb_base(render_fb_base),
	.tile_done(c1_tile_done),
	.busy(c1_busy),
	.rd_addr(c1_rd_addr),
	.rd_burstcnt(c1_rd_burstcnt),
	.rd_req(c1_rd_req),
	.rd_ack(c1_rd_ack),
	.rd_data(c1_rd_data),
	.rd_data_valid(c1_rd_data_valid),
	.wr_addr(c1_wr_addr),
	.wr_burstcnt(c1_wr_burstcnt),
	.wr_data(c1_wr_data),
	.wr_be(c1_wr_be),
	.wr_req(c1_wr_req),
	.wr_ack(c1_wr_ack),
	.wr_busy(c1_wr_busy)
);

// ============================================================
// DDR3 Arbiter
// ============================================================

ddram_arbiter arbiter_inst (
	.clk(clk),
	.reset(reset),

	// Downstream to ddram_ctrl
	.dc_rd_addr(dc_rd_addr),
	.dc_rd_burstcnt(dc_rd_burstcnt),
	.dc_rd_req(dc_rd_req),
	.dc_rd_ack(dc_rd_ack),
	.dc_rd_data(dc_rd_data),
	.dc_rd_data_valid(dc_rd_data_valid),
	.dc_wr_addr(dc_wr_addr),
	.dc_wr_burstcnt(dc_wr_burstcnt),
	.dc_wr_data(dc_wr_data),
	.dc_wr_be(dc_wr_be),
	.dc_wr_req(dc_wr_req),
	.dc_wr_ack(dc_wr_ack),
	.dc_wr_busy(dc_wr_busy),

	// Requestor 0: coordinator
	.r0_rd_addr(coord_rd_addr),
	.r0_rd_burstcnt(coord_rd_burstcnt),
	.r0_rd_req(coord_rd_req),
	.r0_rd_ack(coord_rd_ack),
	.r0_rd_data(coord_rd_data),
	.r0_rd_data_valid(coord_rd_data_valid),
	.r0_wr_addr(coord_wr_addr),
	.r0_wr_burstcnt(coord_wr_burstcnt),
	.r0_wr_data(coord_wr_data),
	.r0_wr_be(coord_wr_be),
	.r0_wr_req(coord_wr_req),
	.r0_wr_ack(coord_wr_ack),
	.r0_wr_busy(coord_wr_busy),

	// Requestor 1: core 0
	.r1_rd_addr(c0_rd_addr),
	.r1_rd_burstcnt(c0_rd_burstcnt),
	.r1_rd_req(c0_rd_req),
	.r1_rd_ack(c0_rd_ack),
	.r1_rd_data(c0_rd_data),
	.r1_rd_data_valid(c0_rd_data_valid),
	.r1_wr_addr(c0_wr_addr),
	.r1_wr_burstcnt(c0_wr_burstcnt),
	.r1_wr_data(c0_wr_data),
	.r1_wr_be(c0_wr_be),
	.r1_wr_req(c0_wr_req),
	.r1_wr_ack(c0_wr_ack),
	.r1_wr_busy(c0_wr_busy),

	// Requestor 2: core 1
	.r2_rd_addr(c1_rd_addr),
	.r2_rd_burstcnt(c1_rd_burstcnt),
	.r2_rd_req(c1_rd_req),
	.r2_rd_ack(c1_rd_ack),
	.r2_rd_data(c1_rd_data),
	.r2_rd_data_valid(c1_rd_data_valid),
	.r2_wr_addr(c1_wr_addr),
	.r2_wr_burstcnt(c1_wr_burstcnt),
	.r2_wr_data(c1_wr_data),
	.r2_wr_be(c1_wr_be),
	.r2_wr_req(c1_wr_req),
	.r2_wr_ack(c1_wr_ack),
	.r2_wr_busy(c1_wr_busy)
);

// ============================================================
// Coordinator FSM
// ============================================================

reg [63:0] poll_data;

always @(posedge clk) begin
	if (reset) begin
		state           <= S_IDLE;
		rendering       <= 0;
		coord_rd_req    <= 0;
		coord_wr_req    <= 0;
		c0_tile_start   <= 0;
		c1_tile_start   <= 0;
		c0_dispatched   <= 0;
		c1_dispatched   <= 0;
		poll_delay      <= 0;
		back_buf        <= 0;
		fb_base_addr    <= FB_A_BYTE;  // start displaying buffer A
	end else begin
		c0_tile_start  <= 0;
		c1_tile_start  <= 0;
		coord_rd_req   <= 0;
		coord_wr_req   <= 0;

		// Clear dispatch flags once core acknowledges by going busy
		if (c0_dispatched && c0_busy) c0_dispatched <= 0;
		if (c1_dispatched && c1_busy) c1_dispatched <= 0;

		// Track tile completions
		if (c0_tile_done && c1_tile_done)
			tile_num <= tile_num + 16'd2;
		else if (c0_tile_done || c1_tile_done)
			tile_num <= tile_num + 16'd1;

		case (state)

		// ---- Poll control block ----
		S_IDLE: begin
			rendering <= 0;
			if (poll_delay == 0) begin
				state <= S_POLL_REQ;
				poll_delay <= 16'd50000;
			end else begin
				poll_delay <= poll_delay - 16'd1;
			end
		end

		S_POLL_REQ: begin
			coord_rd_addr     <= CTRL_ADDR;
			coord_rd_burstcnt <= 8'd1;
			if (coord_rd_ack) begin
				coord_rd_req <= 0;
				state <= S_POLL_WAIT;
			end else begin
				coord_rd_req <= 1;
			end
		end

		S_POLL_WAIT: begin
			if (coord_rd_data_valid) begin
				poll_data <= coord_rd_data;
				if (coord_rd_data[63:32] != 0 && coord_rd_data[28:0] != 0) begin
					first_tile_addr <= coord_rd_data[28:0];
					state           <= S_FRAME_START;
				end else begin
					state <= S_IDLE;
				end
			end
		end

		// ---- Frame start ----
		S_FRAME_START: begin
			rendering       <= 1;
			cur_tile_addr   <= first_tile_addr;
			tiles_remaining <= 1;
			tile_num        <= 0;
			state           <= S_DISPATCH;
		end

		// ---- Dispatch: find idle core, read header, send tile ----
		S_DISPATCH: begin
			if (tiles_remaining) begin
				// Find an idle core to dispatch to
				if (c0_idle) begin
					dispatch_core <= 0;
					state <= S_HDR_REQ;
				end else if (c1_idle) begin
					dispatch_core <= 1;
					state <= S_HDR_REQ;
				end
				// else: both busy, wait (stay in S_DISPATCH)
			end else begin
				// No more tiles to dispatch — wait for all cores to finish
				if (c0_idle && c1_idle) begin
					state <= S_VBLANK_WAIT;
				end
				// else: wait for cores to finish
			end
		end

		// ---- Read tile header (2 qwords) ----
		S_HDR_REQ: begin
			coord_rd_addr     <= cur_tile_addr;
			coord_rd_burstcnt <= 8'd2;
			hdr_word_cnt      <= 0;
			if (coord_rd_ack) begin
				coord_rd_req <= 0;
				state <= S_HDR_WAIT;
			end else begin
				coord_rd_req <= 1;
			end
		end

		S_HDR_WAIT: begin
			if (coord_rd_data_valid) begin
				if (!hdr_word_cnt) begin
					hdr_word0    <= coord_rd_data;
					hdr_word_cnt <= 1;
				end else begin
					// Parse header
					hdr_next_addr  <= hdr_word0[60:32];
					hdr_tile_px    <= coord_rd_data[31:16];
					hdr_tile_py    <= coord_rd_data[47:32];
					hdr_splat_count <= coord_rd_data[15:0];
					state          <= S_HDR_DISPATCH;
				end
			end
		end

		S_HDR_DISPATCH: begin
			// Dispatch to the selected core
			if (dispatch_core == 0) begin
				c0_tile_addr   <= cur_tile_addr;
				c0_tile_px     <= hdr_tile_px;
				c0_tile_py     <= hdr_tile_py;
				c0_splat_count <= hdr_splat_count;
				c0_tile_start  <= 1;
				c0_dispatched  <= 1;
			end else begin
				c1_tile_addr   <= cur_tile_addr;
				c1_tile_px     <= hdr_tile_px;
				c1_tile_py     <= hdr_tile_py;
				c1_splat_count <= hdr_splat_count;
				c1_tile_start  <= 1;
				c1_dispatched  <= 1;
			end

			// Advance to next tile
			if (hdr_next_addr == 29'd0) begin
				tiles_remaining <= 0;
			end else begin
				cur_tile_addr <= hdr_next_addr;
			end

			state <= S_DISPATCH;
		end

		// ---- Wait for vblank before swapping framebuffer ----
		S_VBLANK_WAIT: begin
			if (fb_vbl) begin
				// Swap: the buffer we just rendered to becomes the front buffer
				fb_base_addr <= back_buf ? FB_B_BYTE : FB_A_BYTE;
				back_buf     <= ~back_buf;
				state        <= S_FRAME_DONE_WR;
			end
		end

		// ---- Write frame done ----
		S_FRAME_DONE_WR: begin
			coord_wr_addr     <= CTRL_ADDR + 29'd1;
			coord_wr_burstcnt <= 8'd1;
			coord_wr_data     <= {16'd0, tile_num, 32'd1};
			coord_wr_be       <= 8'hFF;
			if (coord_wr_ack) begin
				coord_wr_req <= 0;
				state <= S_FRAME_DONE;
			end else begin
				coord_wr_req <= 1;
			end
		end

		S_FRAME_DONE: begin
			coord_wr_addr     <= CTRL_ADDR;
			coord_wr_burstcnt <= 8'd1;
			coord_wr_data     <= {32'd0, 3'd0, first_tile_addr};
			coord_wr_be       <= 8'hFF;
			if (coord_wr_ack) begin
				coord_wr_req <= 0;
				state <= S_IDLE;
			end else begin
				coord_wr_req <= 1;
			end
		end

		default: state <= S_IDLE;
		endcase
	end
end

endmodule
