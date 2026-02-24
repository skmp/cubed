/**
 * Inline text editing overlay for 3D scene objects.
 * Uses drei's Html component to position an HTML input at a 3D location.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Text, Html } from '@react-three/drei';

interface EditableLabelProps {
  position: [number, number, number];
  value: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onCommit: (newValue: string) => void;
  onCancel: () => void;
  fontSize?: number;
  color?: string;
  validate?: (value: string) => boolean;
}

export function EditableLabel({
  position,
  value,
  isEditing,
  onStartEdit,
  onCommit,
  onCancel,
  fontSize = 0.18,
  color = '#ffffff',
  validate,
}: EditableLabelProps) {
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditValue(value);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isEditing, value]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      if (!validate || validate(editValue)) {
        onCommit(editValue);
      }
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }, [editValue, onCommit, onCancel, validate]);

  if (isEditing) {
    return (
      <Html position={position} center style={{ pointerEvents: 'auto' }}>
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (!validate || validate(editValue)) {
              onCommit(editValue);
            } else {
              onCancel();
            }
          }}
          style={{
            background: '#1a1a2e',
            color: '#e0e0e0',
            border: '1px solid #4488cc',
            borderRadius: 2,
            padding: '2px 4px',
            fontSize: 12,
            fontFamily: 'monospace',
            outline: 'none',
            minWidth: 60,
            textAlign: 'center',
          }}
        />
      </Html>
    );
  }

  return (
    <Text
      position={position}
      fontSize={fontSize}
      color={color}
      anchorX="center"
      anchorY="middle"
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit();
      }}
    >
      {value}
    </Text>
  );
}
