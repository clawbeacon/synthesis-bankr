interface AgentAvatarProps {
  name: string;
  size?: number;
}

const COLORS = [
  ['#001a0d','#00cc6a'],['#0d0a1e','#a78bfa'],['#1a1000','#fbbf24'],
  ['#0a1220','#60a5fa'],['#1a0808','#f87171'],['#0a1a1a','#2dd4bf'],
];

export function AgentAvatar({ name, size = 32 }: AgentAvatarProps) {
  const idx = name.charCodeAt(0) % COLORS.length;
  const [bg, fg] = COLORS[idx];
  const initials = name.slice(0, 2).toUpperCase();
  const fs = Math.round(size * 0.38);
  return (
    <div style={{
      width: size, height: size, borderRadius: 6,
      background: bg, border: `1px solid ${fg}33`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: fs, fontWeight: 600, color: fg, flexShrink: 0,
      fontFamily: 'monospace', userSelect: 'none',
    }}>
      {initials}
    </div>
  );
}
