export type Param = {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
};

export default function ParamTable({
  title = "Parameters",
  params,
}: {
  title?: string;
  params: Param[];
}) {
  return (
    <div className="table-scroll not-prose my-4">
      <table>
        <thead>
          <tr>
            <th>{title}</th>
            <th>Type</th>
            <th></th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <tr key={p.name}>
              <td>
                <code>{p.name}</code>
              </td>
              <td>
                <span className="font-mono text-[12px]">{p.type}</span>
              </td>
              <td>
                {p.required ? (
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-no">
                    required
                  </span>
                ) : (
                  <span className="font-mono text-[10px] uppercase tracking-wide text-faint">
                    optional
                  </span>
                )}
              </td>
              <td>{p.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
