//
// GSplat top-level coordinator - 4-core architecture with dual buffering.
//
// Orchestrates four gsplat_core instances processing tiles in parallel:
//   1. Poll DDR3 control block for frame request
//   2. Pre-read tile descriptor headers from linked list
//   3. Dispatch tiles to idle cores (pass tile_addr + header data)
//   4. When all tiles done, wait for vblank, swap FB, signal frame_done
//
// DDR3 access is arbitrated by ddram_arbiter (5 requestors:
// coordinator + core0..core3).
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

localparam N_CORES = 4;
localparam N_REQ   = N_CORES + 1;  // cores + coordinator

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

// Which core to dispatch to (0..3)
reg [1:0] dispatch_core;

// Poll delay
reg [15:0] poll_delay;

// CDC synchronizer for fb_vbl (may be in clk_vid domain)
reg fb_vbl_sync1, fb_vbl_sync2;
always @(posedge clk) begin
	fb_vbl_sync1 <= fb_vbl;
	fb_vbl_sync2 <= fb_vbl_sync1;
end

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
// Core instances (4 cores)
// ============================================================

// Per-core control signals
wire [3:0]  core_tile_done;
wire [3:0]  core_busy;
reg  [3:0]  core_tile_start;
reg  [28:0] core_tile_addr  [0:3];
reg  [15:0] core_tile_px    [0:3];
reg  [15:0] core_tile_py    [0:3];
reg  [15:0] core_splat_count[0:3];

// Per-core DDR3 signals
wire [28:0] core_rd_addr    [0:3];
wire  [7:0] core_rd_burstcnt[0:3];
wire [3:0]  core_rd_req;
wire [3:0]  core_rd_ack;
wire [63:0] core_rd_data    [0:3];
wire [3:0]  core_rd_data_valid;

wire [28:0] core_wr_addr    [0:3];
wire  [7:0] core_wr_burstcnt[0:3];
wire [63:0] core_wr_data    [0:3];
wire  [7:0] core_wr_be      [0:3];
wire [3:0]  core_wr_req;
wire [3:0]  core_wr_ack;
wire [3:0]  core_wr_busy;

// Dispatch tracking
reg  [3:0]  core_dispatched;
wire [3:0]  core_idle = ~core_busy & ~core_dispatched;
wire        all_idle  = (core_idle == 4'hF);

genvar gi;

generate
	for (gi = 0; gi < N_CORES; gi = gi + 1) begin : cores
		gsplat_core core_inst (
			.clk(clk),
			.reset(reset),
			.tile_start(core_tile_start[gi]),
			.tile_addr(core_tile_addr[gi]),
			.tile_px(core_tile_px[gi]),
			.tile_py(core_tile_py[gi]),
			.tile_splat_count(core_splat_count[gi]),
			.fb_base(render_fb_base),
			.tile_done(core_tile_done[gi]),
			.busy(core_busy[gi]),
			.rd_addr(core_rd_addr[gi]),
			.rd_burstcnt(core_rd_burstcnt[gi]),
			.rd_req(core_rd_req[gi]),
			.rd_ack(core_rd_ack[gi]),
			.rd_data(core_rd_data[gi]),
			.rd_data_valid(core_rd_data_valid[gi]),
			.wr_addr(core_wr_addr[gi]),
			.wr_burstcnt(core_wr_burstcnt[gi]),
			.wr_data(core_wr_data[gi]),
			.wr_be(core_wr_be[gi]),
			.wr_req(core_wr_req[gi]),
			.wr_ack(core_wr_ack[gi]),
			.wr_busy(core_wr_busy[gi])
		);
	end
endgenerate

// ============================================================
// DDR3 Arbiter - pack signals for parameterized interface
// ============================================================

// Pack per-requestor read signals: [0]=coordinator, [1..4]=cores
wire [N_REQ*29-1:0] arb_rd_addr = {
	core_rd_addr[3], core_rd_addr[2], core_rd_addr[1], core_rd_addr[0],
	coord_rd_addr
};
wire [N_REQ*8-1:0] arb_rd_burstcnt = {
	core_rd_burstcnt[3], core_rd_burstcnt[2], core_rd_burstcnt[1], core_rd_burstcnt[0],
	coord_rd_burstcnt
};
wire [N_REQ-1:0] arb_rd_req = {core_rd_req, coord_rd_req};

wire [N_REQ-1:0]    arb_rd_ack;
wire [N_REQ*64-1:0] arb_rd_data;
wire [N_REQ-1:0]    arb_rd_data_valid;

// Unpack read responses
assign coord_rd_ack        = arb_rd_ack[0];
assign coord_rd_data       = arb_rd_data[63:0];
assign coord_rd_data_valid = arb_rd_data_valid[0];

generate
	for (gi = 0; gi < N_CORES; gi = gi + 1) begin : unpack_rd
		assign core_rd_ack[gi]        = arb_rd_ack[gi+1];
		assign core_rd_data[gi]       = arb_rd_data[(gi+1)*64 +: 64];
		assign core_rd_data_valid[gi] = arb_rd_data_valid[gi+1];
	end
endgenerate

// Pack per-requestor write signals
wire [N_REQ*29-1:0] arb_wr_addr = {
	core_wr_addr[3], core_wr_addr[2], core_wr_addr[1], core_wr_addr[0],
	coord_wr_addr
};
wire [N_REQ*8-1:0] arb_wr_burstcnt = {
	core_wr_burstcnt[3], core_wr_burstcnt[2], core_wr_burstcnt[1], core_wr_burstcnt[0],
	coord_wr_burstcnt
};
wire [N_REQ*64-1:0] arb_wr_data = {
	core_wr_data[3], core_wr_data[2], core_wr_data[1], core_wr_data[0],
	coord_wr_data
};
wire [N_REQ*8-1:0] arb_wr_be = {
	core_wr_be[3], core_wr_be[2], core_wr_be[1], core_wr_be[0],
	coord_wr_be
};
wire [N_REQ-1:0] arb_wr_req = {core_wr_req, coord_wr_req};

wire [N_REQ-1:0] arb_wr_ack;
wire [N_REQ-1:0] arb_wr_busy;

// Unpack write responses
assign coord_wr_ack  = arb_wr_ack[0];
assign coord_wr_busy = arb_wr_busy[0];

generate
	for (gi = 0; gi < N_CORES; gi = gi + 1) begin : unpack_wr
		assign core_wr_ack[gi]  = arb_wr_ack[gi+1];
		assign core_wr_busy[gi] = arb_wr_busy[gi+1];
	end
endgenerate

ddram_arbiter #(.N_REQ(N_REQ)) arbiter_inst (
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

	// Packed requestor interfaces
	.req_rd_addr(arb_rd_addr),
	.req_rd_burstcnt(arb_rd_burstcnt),
	.req_rd_req(arb_rd_req),
	.req_rd_ack(arb_rd_ack),
	.req_rd_data(arb_rd_data),
	.req_rd_data_valid(arb_rd_data_valid),
	.req_wr_addr(arb_wr_addr),
	.req_wr_burstcnt(arb_wr_burstcnt),
	.req_wr_data(arb_wr_data),
	.req_wr_be(arb_wr_be),
	.req_wr_req(arb_wr_req),
	.req_wr_ack(arb_wr_ack),
	.req_wr_busy(arb_wr_busy)
);

// ============================================================
// Tile completion counting
// ============================================================

wire [2:0] done_count = {2'd0, core_tile_done[0]} + {2'd0, core_tile_done[1]}
                       + {2'd0, core_tile_done[2]} + {2'd0, core_tile_done[3]};

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
		core_tile_start <= 4'd0;
		core_dispatched <= 4'd0;
		poll_delay      <= 0;
		back_buf        <= 1;          // first frame renders to B
		fb_base_addr    <= FB_A_BYTE;  // start displaying buffer A (empty/black)
	end else begin
		core_tile_start <= 4'd0;
		coord_rd_req    <= 0;
		coord_wr_req    <= 0;

		// Clear dispatch flags once core acknowledges by going busy
		core_dispatched <= core_dispatched & ~(core_dispatched & core_busy);

		// Track tile completions
		if (done_count != 0)
			tile_num <= tile_num + {13'd0, done_count};

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
				if (core_idle[0]) begin
					dispatch_core <= 2'd0;
					state <= S_HDR_REQ;
				end else if (core_idle[1]) begin
					dispatch_core <= 2'd1;
					state <= S_HDR_REQ;
				end else if (core_idle[2]) begin
					dispatch_core <= 2'd2;
					state <= S_HDR_REQ;
				end else if (core_idle[3]) begin
					dispatch_core <= 2'd3;
					state <= S_HDR_REQ;
				end
				// else: all busy, wait (stay in S_DISPATCH)
			end else begin
				// No more tiles to dispatch — wait for all cores to finish
				if (all_idle)
					state <= S_VBLANK_WAIT;
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
			core_tile_addr[dispatch_core]   <= cur_tile_addr;
			core_tile_px[dispatch_core]     <= hdr_tile_px;
			core_tile_py[dispatch_core]     <= hdr_tile_py;
			core_splat_count[dispatch_core] <= hdr_splat_count;
			case (dispatch_core)
			2'd0: begin core_tile_start <= 4'b0001; core_dispatched <= (core_dispatched & ~core_busy) | 4'b0001; end
			2'd1: begin core_tile_start <= 4'b0010; core_dispatched <= (core_dispatched & ~core_busy) | 4'b0010; end
			2'd2: begin core_tile_start <= 4'b0100; core_dispatched <= (core_dispatched & ~core_busy) | 4'b0100; end
			2'd3: begin core_tile_start <= 4'b1000; core_dispatched <= (core_dispatched & ~core_busy) | 4'b1000; end
			endcase

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
			if (fb_vbl_sync2) begin
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
