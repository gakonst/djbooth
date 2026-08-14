const bars = [18, 34, 52, 26, 64, 78, 46, 29, 70, 88, 55, 34, 62, 73, 42, 20, 48, 82, 68, 30, 58, 76, 39, 24, 50, 66, 84, 42, 30, 60, 72, 36, 22, 44, 80, 56, 28, 64, 74, 38];

export function Waveform() {
  return (
    <div className="waveform" aria-hidden="true">
      {bars.map((height, index) => (
        <i key={index} style={{ "--bar-height": `${height}%` } as React.CSSProperties} />
      ))}
      <b />
    </div>
  );
}
