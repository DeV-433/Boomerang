export function Placeholder({ title, step }: { title: string; step?: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">{step ? `Arrives in step ${step}.` : "There is no page here."}</p>
    </section>
  );
}
