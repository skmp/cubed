/**
 * Right-click context menu for the 3D WYSIWYG editor.
 * Renders as a MUI Menu positioned at the click coordinates.
 */
import { Menu, MenuItem, Divider, ListItemIcon, ListItemText } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import type { ContextMenuState } from '../../stores/editorStore';

interface ContextMenu3DProps {
  state: ContextMenuState | null;
  onClose: () => void;
  onAddApplication: () => void;
  onAddNode: () => void;
  onDelete: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onEditValue: () => void;
  onDisconnect: () => void;
}

export function ContextMenu3D({
  state,
  onClose,
  onAddApplication,
  onAddNode,
  onDelete,
  onRename,
  onDuplicate,
  onEditValue,
  onDisconnect,
}: ContextMenu3DProps) {
  if (!state?.visible) return null;

  const [x, y] = state.screenPosition;

  return (
    <Menu
      open
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={{ left: x, top: y }}
      slotProps={{
        paper: {
          sx: {
            bgcolor: '#1a1a2e',
            border: '1px solid #333',
            minWidth: 180,
            '& .MuiMenuItem-root': {
              fontSize: 13,
              py: 0.5,
            },
          },
        },
      }}
    >
      {/* Empty space context */}
      {state.targetType === 'empty' && [
        <MenuItem key="add-app" onClick={() => { onAddApplication(); onClose(); }}>
          <ListItemIcon><AddIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Add Application</ListItemText>
        </MenuItem>,
        <MenuItem key="add-node" onClick={() => { onAddNode(); onClose(); }}>
          <ListItemIcon><AddIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Add Node</ListItemText>
        </MenuItem>,
      ]}

      {/* Application context */}
      {state.targetType === 'application' && [
        <MenuItem key="rename" onClick={() => { onRename(); onClose(); }}>
          <ListItemIcon><EditIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Edit Name</ListItemText>
        </MenuItem>,
        <MenuItem key="dup" onClick={() => { onDuplicate(); onClose(); }}>
          <ListItemIcon><ContentCopyIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Duplicate</ListItemText>
        </MenuItem>,
        <Divider key="div1" />,
        <MenuItem key="delete" onClick={() => { onDelete(); onClose(); }}>
          <ListItemIcon><DeleteIcon sx={{ fontSize: 16, color: '#f44336' }} /></ListItemIcon>
          <ListItemText sx={{ color: '#f44336' }}>Delete</ListItemText>
        </MenuItem>,
      ]}

      {/* Definition context */}
      {state.targetType === 'definition' && [
        <MenuItem key="rename" onClick={() => { onRename(); onClose(); }}>
          <ListItemIcon><EditIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>,
        <Divider key="div1" />,
        <MenuItem key="delete" onClick={() => { onDelete(); onClose(); }}>
          <ListItemIcon><DeleteIcon sx={{ fontSize: 16, color: '#f44336' }} /></ListItemIcon>
          <ListItemText sx={{ color: '#f44336' }}>Delete</ListItemText>
        </MenuItem>,
      ]}

      {/* Literal context */}
      {state.targetType === 'literal' && [
        <MenuItem key="edit" onClick={() => { onEditValue(); onClose(); }}>
          <ListItemIcon><EditIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Edit Value</ListItemText>
        </MenuItem>,
        <Divider key="div1" />,
        <MenuItem key="delete" onClick={() => { onDelete(); onClose(); }}>
          <ListItemIcon><DeleteIcon sx={{ fontSize: 16, color: '#f44336' }} /></ListItemIcon>
          <ListItemText sx={{ color: '#f44336' }}>Delete</ListItemText>
        </MenuItem>,
      ]}

      {/* Holder (variable) context */}
      {state.targetType === 'holder' && [
        <MenuItem key="rename" onClick={() => { onRename(); onClose(); }}>
          <ListItemIcon><EditIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>,
        <Divider key="div1" />,
        <MenuItem key="delete" onClick={() => { onDelete(); onClose(); }}>
          <ListItemIcon><DeleteIcon sx={{ fontSize: 16, color: '#f44336' }} /></ListItemIcon>
          <ListItemText sx={{ color: '#f44336' }}>Delete</ListItemText>
        </MenuItem>,
      ]}

      {/* Pipe context */}
      {state.targetType === 'pipe' && (
        <MenuItem onClick={() => { onDisconnect(); onClose(); }}>
          <ListItemIcon><LinkOffIcon sx={{ fontSize: 16 }} /></ListItemIcon>
          <ListItemText>Disconnect</ListItemText>
        </MenuItem>
      )}
    </Menu>
  );
}
