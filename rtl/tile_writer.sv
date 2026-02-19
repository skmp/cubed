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
localparam FB_BASE  = 29'h06000000;  // 0x30000000 >> 3
localparam FB_STRIDE_BYTES = 2560;   // 640 * 4

// States
localparam S_IDLE      = 3'd0;
localparam S_ROW_START = 3'd1;
localparam S_READ_PIX0 = 3'd2;
localparam S_READ_PIX1 = 3'd3;
localparam S_WRITE     = 3'd4;
localparam S_DONE      = 3'd5;

reg [2:0] state;
reg [4:0] row;     // 0..31
reg [4:0] col;     // 0..31 (processes 2 pixels at a time, so steps by 2)
reg       first_in_row;

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
reg [15:0] pix1_r, pix1_g, pix1_b, pix1_a;

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
			first_in_row <= 1;
			// Start reading first pixel of row
			tb_rd_addr <= {row, 5'd0};  // pixel (row, 0)
			state <= S_READ_PIX0;
		end

		S_READ_PIX0: begin
			// BRAM has 1-cycle latency. Read data available now for previous address.
			// Issue read for second pixel
			tb_rd_addr <= {row, col + 5'd1};

			if (!first_in_row) begin
				// tb_rd_data has pixel at col
				// MiSTer ascal 32bpp format 110: byte[0]=R, byte[1]=G, byte[2]=B, byte[3]=xx
				// As 32-bit LE integer: 0xXXBBGGRR
				pixel0 <= {8'hFF,                          // byte[3] = unused/alpha
				           to_8bit(tb_rd_data[47:32]),     // byte[2] = B
				           to_8bit(tb_rd_data[31:16]),     // byte[1] = G
				           to_8bit(tb_rd_data[15:0])};     // byte[0] = R
			end else begin
				first_in_row <= 0;
				// First iteration: read addr was set in ROW_START, data not ready yet
				// We need one more cycle. Issue address again and re-enter.
				tb_rd_addr <= {row, col};
				state <= S_READ_PIX0;  // Stay here one more cycle
				first_in_row <= 0;
			end

			if (!first_in_row) begin
				state <= S_READ_PIX1;
			end
		end

		S_READ_PIX1: begin
			// tb_rd_data now has second pixel
			// MiSTer ascal 32bpp format: 0xXXBBGGRR (LE)
			pixel1 <= {8'hFF,
			           to_8bit(tb_rd_data[47:32]),
			           to_8bit(tb_rd_data[31:16]),
			           to_8bit(tb_rd_data[15:0])};

			// Pre-read next pixel pair's first pixel
			if (col + 2 < TILE_W) begin
				tb_rd_addr <= {row, col + 5'd2};
			end

			state <= S_WRITE;
		end

		S_WRITE: begin
			// Compute DDR3 address for this pixel pair
			// byte_addr = FB_BASE_BYTES + (tile_py + row) * STRIDE + (tile_px + col) * 4
			// ddram_addr = byte_addr >> 3
			wr_addr <= FB_BASE +
			           (({14'd0, tile_py} + {14'd0, 11'd0, row}) * (FB_STRIDE_BYTES >> 3)) +
			           (({14'd0, tile_px} + {14'd0, 11'd0, col}) >> 1);
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
