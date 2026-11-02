/** A ticket's labels as quiet chips. */
export function Chips({ labels }: { labels: readonly string[] }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label}
          data-label={label}
          className="inline-flex h-5 items-center rounded-full bg-fill px-1.75 text-meta text-text-3 shadow-ring"
        >
          {label}
        </span>
      ))}
    </span>
  );
}
