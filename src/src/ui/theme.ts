import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#90caf9' },
    secondary: { main: '#ce93d8' },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
  },
  typography: {
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    fontSize: 12,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { overflow: 'hidden' },
      },
    },
  },
});

// Node state colors
export const NODE_COLORS = {
  running: '#4CAF50',
  blocked_read: '#2196F3',
  blocked_write: '#FF9800',
  suspended: '#424242',
  selected: '#FFD700',
} as const;
