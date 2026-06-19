import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, Home } from "lucide-react";
import { useIndex } from "../store/index-store";
import type { Account } from "../lib/tauri/commands";
import type { AccountIndex } from "../lib/account-index";

interface NodeProps {
  index: AccountIndex;
  dirPath: string;
  dirName: string;
  depth: number;
  currentPath: string;
  onNavigate: (path: string) => void;
}

function TreeNode({ index, dirPath, dirName, depth, currentPath, onNavigate }: NodeProps) {
  const [open, setOpen] = useState(false);
  const childDirs = (index.tree[dirPath] ?? []).filter((c) => c.IsDir);
  const active = currentPath === dirPath;

  return (
    <div>
      <div
        className={`flex items-center gap-0.5 rounded-[7px] pr-2 ${
          active ? "bg-[var(--accent-weak)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)]"
        }`}
        style={{ paddingLeft: depth * 12 + 2 }}
      >
        <button
          onClick={() => setOpen((o) => !o)}
          className={`p-1 ${childDirs.length ? "text-[var(--text-3)] hover:text-[var(--text)]" : "invisible"}`}
          aria-label="Expand"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button onClick={() => onNavigate(dirPath)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm">
          <Folder size={15} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{dirName}</span>
        </button>
      </div>
      {open &&
        childDirs.map((c) => (
          <TreeNode
            key={c.Path}
            index={index}
            dirPath={c.Path}
            dirName={c.Name}
            depth={depth + 1}
            currentPath={currentPath}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  );
}

export function SidebarTree({
  account,
  currentPath,
  onNavigate,
}: {
  account: Account;
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  const index = useIndex((s) => s.byAccount[account.id]?.index);
  const rootDirs = (index?.tree[""] ?? []).filter((d) => d.IsDir);
  const homeLabel = account.provider === "drive" ? "Shared with me" : "Home";

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-auto border-r border-[var(--border)] bg-[var(--surface)] p-2">
      <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-[var(--text-3)]">FOLDERS</div>
      <button
        onClick={() => onNavigate("")}
        className={`mb-1 flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-sm ${
          currentPath === "" ? "bg-[var(--accent-weak)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)]"
        }`}
      >
        <Home size={14} className="text-[var(--accent)]" /> {homeLabel}
      </button>
      {index &&
        rootDirs.map((d) => (
          <TreeNode
            key={d.Path}
            index={index}
            dirPath={d.Path}
            dirName={d.Name}
            depth={0}
            currentPath={currentPath}
            onNavigate={onNavigate}
          />
        ))}
    </aside>
  );
}
