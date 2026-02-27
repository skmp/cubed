import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog, DialogTitle, DialogContent, Box, TextField, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';

interface SerialPort {
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  readable: ReadableStream<Uint8Array> | null;
}

interface SerialConsoleDialogProps {
  open: boolean;
  port: SerialPort | null;
  onClose: () => void;
}

function formatBytes(data: Uint8Array): string {
  let result = '';
  for (const b of data) {
    if (b >= 0x20 && b <= 0x7e) result += String.fromCharCode(b);
    else if (b === 0x0a) result += '\n';
    else if (b === 0x0d) result += '';
    else if (b === 0x09) result += '\t';
    else result += '.';
  }
  return result;
}

export const SerialConsoleDialog: React.FC<SerialConsoleDialogProps> = ({ open, port, onClose }) => {
  const [receivedData, setReceivedData] = useState('');
  const [inputText, setInputText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const closingRef = useRef(false);

  // Read loop
  useEffect(() => {
    if (!open || !port?.readable) return;
    closingRef.current = false;

    const reader = port.readable.getReader();
    readerRef.current = reader;

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            setReceivedData(prev => {
              const next = prev + formatBytes(value);
              return next.length > 100_000 ? next.slice(-80_000) : next;
            });
          }
        }
      } catch (err) {
        if (!closingRef.current) {
          setReceivedData(prev => prev + `\n[Read error: ${err}]\n`);
        }
      }
    })();

    return () => {
      closingRef.current = true;
      reader.cancel().catch(() => {});
    };
  }, [open, port]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [receivedData]);

  const handleSend = useCallback(async () => {
    if (!port?.writable || !inputText) return;
    const writer = port.writable.getWriter();
    const bytes = new TextEncoder().encode(inputText);
    await writer.write(bytes);
    writer.releaseLock();
    setReceivedData(prev => prev + `> ${inputText}\n`);
    setInputText('');
  }, [port, inputText]);

  const handleClose = useCallback(async () => {
    closingRef.current = true;
    if (readerRef.current) {
      await readerRef.current.cancel().catch(() => {});
      readerRef.current = null;
    }
    if (port) {
      try { await port.close(); } catch { /* ignore */ }
    }
    setReceivedData('');
    onClose();
  }, [port, onClose]);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 1 }}>
        Serial Console
        <IconButton onClick={handleClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1 }}>
        <Box
          ref={scrollRef}
          sx={{
            height: 400,
            overflow: 'auto',
            bgcolor: '#0a0a14',
            p: 1,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            fontSize: 12,
            color: '#0f0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            border: '1px solid #333',
            borderRadius: 1,
          }}
        >
          {receivedData || '(waiting for data...)'}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Type to send..."
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }}
            inputProps={{ style: { fontFamily: '"JetBrains Mono", monospace', fontSize: 13 } }}
            autoFocus
          />
          <IconButton onClick={handleSend} disabled={!inputText}>
            <SendIcon />
          </IconButton>
        </Box>
      </DialogContent>
    </Dialog>
  );
};
