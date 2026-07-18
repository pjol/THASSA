const METHOD_STYLES: Record<string, string> = {
  GET: "bg-yes/10 text-yes border-yes/30",
  POST: "bg-brand/10 text-brand border-brand/30",
  DELETE: "bg-no/10 text-no border-no/30",
  WS: "bg-settling/10 text-settling border-settling/30",
};

// Endpoint signature banner: METHOD + path + auth badge.
export default function Endpoint({
  method,
  path,
  auth,
}: {
  method: "GET" | "POST" | "DELETE" | "WS";
  path: string;
  auth: string;
}) {
  return (
    <div className="not-prose my-4 flex flex-wrap items-center gap-3 rounded-xl border hairline bg-card px-4 py-3">
      <span
        className={`rounded-md border px-2 py-0.5 font-mono text-[11px] font-bold tracking-wide ${METHOD_STYLES[method]}`}
      >
        {method}
      </span>
      <code className="break-all font-mono text-[13px] font-semibold text-fg">{path}</code>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
        {auth}
      </span>
    </div>
  );
}
