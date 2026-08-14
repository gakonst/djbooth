export function SignalFlow({ steps, caption }: { steps: string[]; caption?: string }) {
  return (
    <figure className="signal-flow">
      <div>
        {steps.map((step, index) => (
          <span key={step}>
            <b>{step}</b>
            {index < steps.length - 1 ? <i aria-hidden="true">→</i> : null}
          </span>
        ))}
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
