import React from "react";
import { Clapperboard, Cpu, FolderGit2, Terminal } from "lucide-react";

export const ProjectIcon: React.FC<{
  icon?: string;
  accentToken?: string;
  size?: "sm" | "md";
}> = ({ icon = "folder", accentToken = "--accent-primary", size = "md" }) => {
  const cls = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  const boxCls =
    size === "sm"
      ? "w-8 h-8 rounded-[var(--radius-inner)]"
      : "w-10 h-10 rounded-[var(--radius-inner)]";

  const colorVar = accentToken.startsWith("var(")
    ? accentToken
    : accentToken.startsWith("--")
      ? `var(${accentToken})`
      : "var(--accent-primary)";

  const renderInner = () => {
    switch (icon) {
      case "clapperboard":
        return <Clapperboard className={cls} />;
      case "terminal":
        return <Terminal className={cls} />;
      case "cpu":
        return <Cpu className={cls} />;
      case "folder":
      case "git":
        return <FolderGit2 className={cls} />;
      default:
        return <span className="text-base leading-none">{icon}</span>;
    }
  };

  return (
    <span
      className={`${boxCls} inline-flex items-center justify-center shrink-0 border`}
      style={{
        backgroundColor: "var(--bg-subtle)",
        borderColor: colorVar,
        color: colorVar,
      }}
      aria-hidden="true"
    >
      {renderInner()}
    </span>
  );
};
