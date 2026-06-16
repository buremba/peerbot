import { cellStyle, DataTable } from "./DataTable";

const starterSkills = [
  {
    product: "Lobu",
    install: "Enable from the agent settings UI",
    adds: "The Lobu starter skill in skills/lobu/ (includes memory guidance)",
  },
];

export function SkillsRegistryTable() {
  return (
    <div>
      <h2>Starter Skills</h2>
      <p>
        Lobu ships one starter skill. Lobu also discovers local skills from{" "}
        <code>skills/&lt;name&gt;/SKILL.md</code> or{" "}
        <code>agents/&lt;agent-id&gt;/skills/&lt;name&gt;/SKILL.md</code>.
      </p>
      <DataTable headers={["Product", "Install", "What it adds"]}>
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
            <code>agents/&lt;agent-id&gt;/skills/&lt;name&gt;/SKILL.md</code>
          </td>
          <td style={cellStyle}>
            A project-owned custom skill discovered automatically
          </td>
        </tr>
      </DataTable>
    </div>
  );
}
