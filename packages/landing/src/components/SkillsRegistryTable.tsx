const cellStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-page-border)",
  fontSize: "13px",
  color: "var(--color-page-text-muted)",
};

const headerCellStyle = {
  ...cellStyle,
  fontWeight: 600,
  color: "var(--color-page-text)",
  backgroundColor: "var(--color-page-surface-dim)",
};

const starterSkills = [
  {
    product: "Lobu",
    install: "npx @lobu/cli@latest skills add lobu",
    adds: "The Lobu starter skill in skills/lobu/",
  },
  {
    product: "Owletto",
    install: "npx owletto@latest skills add owletto",
    adds: "The Owletto starter skill in skills/owletto/",
  },
  {
    product: "Owletto",
    install: "npx owletto@latest skills add owletto-openclaw",
    adds: "The OpenClaw-specific Owletto starter skill",
  },
];

export function SkillsRegistryTable() {
  return (
    <div>
      <h2>Starter Skills</h2>
      <p>
        Lobu and Owletto ship separate starter-skill installers. After install,
        Lobu still discovers local skills from{" "}
        <code>skills/&lt;name&gt;/SKILL.md</code> or{" "}
        <code>agents/&lt;agent-id&gt;/skills/&lt;name&gt;/SKILL.md</code>.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            border: "1px solid var(--color-page-border)",
          }}
        >
          <thead>
            <tr>
              <th style={headerCellStyle}>Product</th>
              <th style={headerCellStyle}>Install command</th>
              <th style={headerCellStyle}>What it adds</th>
            </tr>
          </thead>
          <tbody>
            {starterSkills.map((skill) => (
              <tr key={skill.install}>
                <td style={cellStyle}>{skill.product}</td>
                <td style={cellStyle}>
                  <code>{skill.install}</code>
                </td>
                <td style={cellStyle}>{skill.adds}</td>
              </tr>
            ))}
            <tr>
              <td style={cellStyle}>Local skill</td>
              <td style={cellStyle}>
                <code>skills/&lt;name&gt;/SKILL.md</code> or{" "}
                <code>
                  agents/&lt;agent-id&gt;/skills/&lt;name&gt;/SKILL.md
                </code>
              </td>
              <td style={cellStyle}>
                A project-owned custom skill discovered automatically
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
