import React, { useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Button, Box, Typography, TextField, LinearProgress, Alert, Tooltip,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import UsbIcon from '@mui/icons-material/Usb';

// Web Serial API type declarations (not in standard lib)
interface SerialPortOptions { baudRate: number }
interface WebSerialPort {
  open(options: SerialPortOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
}
interface Serial {
  requestPort(): Promise<WebSerialPort>;
}

function getSerial(): Serial | null {
  const nav = navigator as Navigator & { serial?: Serial };
  return nav.serial ?? null;
}

interface BootStreamModalProps {
  bytes: Uint8Array | null;
  onClose: () => void;
}

type SerialState =
  | { status: 'idle' }
  | { status: 'sending'; progress: number }
  | { status: 'done'; bytesSent: number }
  | { status: 'error'; message: string };

const CHUNK_SIZE = 64;

export const BootStreamModal: React.FC<BootStreamModalProps> = ({ bytes, onClose }) => {
  const [baudRate, setBaudRate] = useState(460800);
  const [serialState, setSerialState] = useState<SerialState>({ status: 'idle' });

  const serial = getSerial();
  const serialSupported = serial !== null;

  const handleDownload = useCallback(() => {
    if (!bytes) return;
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bootstream.bin';
    a.click();
    URL.revokeObjectURL(url);
    onClose();
  }, [bytes, onClose]);

  const handleSendSerial = useCallback(async () => {
    if (!bytes || !serial) return;

    let port: WebSerialPort | null = null;
    try {
      port = await serial.requestPort();
      await port.open({ baudRate });

      // Reset target chip via RTS (active low on EVB002 J22 pins 3-4)
      setSerialState({ status: 'sending', progress: 0 });
      await port.setSignals({ requestToSend: true });
      await new Promise(r => setTimeout(r, 50));
      await port.setSignals({ requestToSend: false });
      await new Promise(r => setTimeout(r, 100));

      const writer = port.writable!.getWriter();
      const total = bytes.length;
      let sent = 0;

      while (sent < total) {
        const end = Math.min(sent + CHUNK_SIZE, total);
        const chunk = bytes.slice(sent, end);
        await writer.write(chunk);
        sent = end;
        setSerialState({ status: 'sending', progress: (sent / total) * 100 });
      }

      writer.releaseLock();
      await port.close();
      setSerialState({ status: 'done', bytesSent: total });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // DOMException with name "NotFoundError" means the user cancelled the picker
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        setSerialState({ status: 'idle' });
        return;
      }
      setSerialState({ status: 'error', message });
      try { if (port) await port.close(); } catch { /* ignore */ }
    }
  }, [bytes, baudRate, serial]);

  const handleClose = useCallback(() => {
    if (serialState.status === 'sending') return; // don't close while sending
    setSerialState({ status: 'idle' });
    onClose();
  }, [serialState, onClose]);

  if (!bytes) return null;

  const sending = serialState.status === 'sending';

  return (
    <Dialog
      open
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{ sx: { backgroundColor: '#1e1e1e', backgroundImage: 'none' } }}
    >
      <DialogTitle sx={{ color: '#ccc', fontSize: '14px', pb: 1 }}>
        Deploy Boot Stream
      </DialogTitle>

      <DialogContent sx={{ color: '#aaa', pt: 1 }}>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {bytes.length} bytes ({Math.ceil(bytes.length / 3)} words)
        </Typography>

        {serialState.status === 'sending' && (
          <Box sx={{ mb: 2 }}>
            <LinearProgress variant="determinate" value={serialState.progress} />
            <Typography variant="caption" sx={{ color: '#888', mt: 0.5, display: 'block' }}>
              Sending... {Math.round(serialState.progress)}%
            </Typography>
          </Box>
        )}

        {serialState.status === 'done' && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Sent {serialState.bytesSent} bytes successfully
          </Alert>
        )}

        {serialState.status === 'error' && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {serialState.message}
          </Alert>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" sx={{ color: '#888', whiteSpace: 'nowrap' }}>
            Baud rate:
          </Typography>
          <TextField
            type="number"
            size="small"
            value={baudRate}
            onChange={(e) => setBaudRate(Math.max(1, parseInt(e.target.value) || 460800))}
            disabled={sending}
            slotProps={{ htmlInput: { min: 1 } }}
            sx={{
              width: 100,
              '& input': { fontSize: '11px', py: 0.5, px: 1, color: '#ccc' },
              '& fieldset': { borderColor: '#444' },
            }}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ p: 2, gap: 1 }}>
        <Button
          onClick={handleClose}
          variant="outlined"
          size="small"
          disabled={sending}
          sx={{ textTransform: 'none', fontSize: '11px' }}
        >
          Close
        </Button>
        <Button
          onClick={handleDownload}
          variant="contained"
          size="small"
          startIcon={<DownloadIcon />}
          disabled={sending}
          sx={{ textTransform: 'none', fontSize: '11px' }}
        >
          Download .bin
        </Button>
        <Tooltip
          title={serialSupported ? '' : 'Web Serial API not available (use Chrome/Edge)'}
        >
          <span>
            <Button
              onClick={handleSendSerial}
              variant="contained"
              color="success"
              size="small"
              startIcon={<UsbIcon />}
              disabled={!serialSupported || sending}
              sx={{ textTransform: 'none', fontSize: '11px' }}
            >
              Send over Serial
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
};
