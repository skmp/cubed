//
// Tile writer - reads tile buffer BRAM, converts u0.10 to ARGB8888,
// and writes completed tile to DDR3 framebuffer via DDRAM.
//
// Each 32-pixel row is written as a 16-word burst (2 pixels per 64-bit word).
// 32 rows = 32 bursts per tile.
//

module tile_writer (
	input         clk,
	input         reset,

	// Control
	input         start,
	output reg    done,
	input  [15:0] tile_px,    // tile origin X in pixels
	input  [15:0] tile_py,    // tile origin Y in pixels
	input  [28:0] fb_base,    // framebuffer DDR3 qword base address

	// Tile buffer read interface
	output reg  [9:0] tb_rd_addr,
	input      [63:0] tb_rd_data,   // {A[15:0], B[15:0], G[15:0], R[15:0]}

	// DDRAM write interface (directly to ddram_ctrl)
	output reg [28:0] wr_addr,
	output reg  [7:0] wr_burstcnt,
	output reg [63:0] wr_data,
	output reg  [7:0] wr_be,
	output reg        wr_req,
	input             wr_ack,
	input             wr_busy
);

localparam TILE_W = 32;
localparam TILE_H = 32;
localparam SCREEN_W = 640;
localparam FB_STRIDE_BYTES = 2560;   // 640 * 4

// States
localparam S_IDLE           = 4'd0;
localparam S_ROW_START      = 4'd1;
localparam S_READ_PIX0_WAIT = 4'd2;  // wait for BRAM latency on pixel0
localparam S_READ_PIX0      = 4'd3;
localparam S_READ_PIX1_WAIT = 4'd4;  // wait for BRAM latency on pixel1
localparam S_READ_PIX1      = 4'd5;
localparam S_WRITE          = 4'd6;
localparam S_DONE           = 4'd7;

reg [3:0] state;
reg [4:0] row;     // 0..31
reg [4:0] col;     // 0..31 (processes 2 pixels at a time, so steps by 2)

// Pixel conversion: u0.10 -> u0.8 (shift right by 2, clamp to 255)
function [7:0] to_8bit(input [15:0] val);
	if (val[15:10] != 0)
		to_8bit = 8'hFF;
	else if (val[9:2] == 8'hFF && val[1:0] != 0)
		to_8bit = 8'hFF;
	else
		to_8bit = val[9:2];
endfunction

// Stored pixel pair for burst writing
reg [31:0] pixel0;
reg [31:0] pixel1;

// Combinational address computation (avoids truncation warning)
wire [31:0] tw_pixel_addr = {3'd0, fb_base} +
	(({14'd0, tile_py} + {14'd0, 11'd0, row}) * (FB_STRIDE_BYTES >> 3)) +
	(({14'd0, tile_px} + {14'd0, 11'd0, col}) >> 1);

always @(posedge clk) begin
	if (reset) begin
		state  <= S_IDLE;
		done   <= 0;
		wr_req <= 0;
	end else begin
		done   <= 0;
		wr_req <= 0;

		case (state)
		S_IDLE: begin
			if (start) begin
				row <= 0;
				state <= S_ROW_START;
			end
		end

		S_ROW_START: begin
			col <= 0;
			// Issue BRAM read for first pixel of row
			tb_rd_addr <= {row, 5'd0};  // pixel (row, 0)
			state <= S_READ_PIX0_WAIT;
		end

		S_READ_PIX0_WAIT: begin
			// Wait 1 cycle for BRAM read latency.
			// Address was issued in ROW_START (first pair) or
			// pre-issued in S_READ_PIX1 (subsequent pairs).
			// BRAM data will be valid at the next edge.
			state <= S_READ_PIX0;
		end

		S_READ_PIX0: begin
			// BRAM data is now valid for pixel0 (2 edges after addr issue).
			// Capture pixel0.
			// MiSTer ascal 32bpp format 110: byte[0]=R, [1]=G, [2]=B, [3]=xx
			// As 32-bit LE integer: 0xXXBBGGRR
			pixel0 <= {8'hFF,                          // byte[3] = unused/alpha
			           to_8bit(tb_rd_data[47:32]),     // byte[2] = B
			           to_8bit(tb_rd_data[31:16]),     // byte[1] = G
			           to_8bit(tb_rd_data[15:0])};     // byte[0] = R

			// Issue BRAM read for pixel1 (col+1)
			tb_rd_addr <= {row, col + 5'd1};
			state <= S_READ_PIX1_WAIT;
		end

		S_READ_PIX1_WAIT: begin
			// Wait 1 cycle for BRAM read latency on pixel1.
			state <= S_READ_PIX1;
		end

		S_READ_PIX1: begin
			// BRAM data now has pixel1 (2 edges after addr issue).
			pixel1 <= {8'hFF,
			           to_8bit(tb_rd_data[47:32]),
			           to_8bit(tb_rd_data[31:16]),
			           to_8bit(tb_rd_data[15:0])};

			// Pre-issue BRAM read for next pair's pixel0
			if (col + 2 < TILE_W) begin
				tb_rd_addr <= {row, col + 5'd2};
			end

			state <= S_WRITE;
		end

		S_WRITE: begin
			// Compute DDR3 address for this pixel pair
			// byte_addr = FB_BASE_BYTES + (tile_py + row) * STRIDE + (tile_px + col) * 4
			// ddram_addr = byte_addr >> 3
			wr_addr <= tw_pixel_addr[28:0];
			wr_burstcnt <= 8'd1;
			wr_data <= {pixel1, pixel0};  // two 32-bit pixels in one 64-bit word
			wr_be   <= 8'hFF;
			// Hold wr_req asserted until ack is received, then deassert
			if (wr_ack) begin
				wr_req <= 0;  // Deassert immediately on ack to prevent spurious write
				if (col + 2 >= TILE_W) begin
					// End of row
					if (row + 1 >= TILE_H) begin
						state <= S_DONE;
					end else begin
						row   <= row + 5'd1;
						state <= S_ROW_START;
					end
				end else begin
					col   <= col + 5'd2;
					state <= S_READ_PIX0;
				end
			end else begin
				wr_req <= 1;
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
