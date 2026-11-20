import { describe, expect, it } from "vitest";
import { can, normalize, roleLabel } from "./permissions";
import type { Project } from "../types";

const baseProject = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  key: "MW",
  name: "MightyWork",
  description: "",
  created_by: "u1",
  task_seq: 0,
  my_permissions: ["view"],
  is_owner: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("permissions", () => {
  it("always includes view and expands admin to all permissions", () => {
    expect(normalize([])).toEqual(["view"]);
    expect(normalize(["edit", "create"])).toEqual(["view", "create", "edit"]);
    expect(normalize(["admin"])).toEqual(["view", "create", "edit", "delete", "admin"]);
  });

  it("checks capabilities and derives role labels", () => {
    const owner = baseProject({ is_owner: true, my_permissions: ["view", "create", "edit", "delete", "admin"] });
    const admin = baseProject({ my_permissions: ["view", "create", "edit", "delete", "admin"] });
    const viewer = baseProject({ my_permissions: ["view"] });
    const editor = baseProject({ my_permissions: ["view", "create", "edit"] });

    expect(can(owner, "delete")).toBe(true);
    expect(can(viewer, "edit")).toBe(false);
    expect(roleLabel(owner)).toBe("소유자");
    expect(roleLabel(admin)).toBe("관리자");
    expect(roleLabel(viewer)).toBe("보기 전용");
    expect(roleLabel(editor)).toBe("멤버");
  });
});
