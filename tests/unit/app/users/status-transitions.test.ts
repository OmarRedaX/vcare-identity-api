import { UserStatus } from "../../../../src/app/auth/enums";
import { ADMIN_TRANSITIONS, SERVICE_TRANSITIONS } from "../../../../src/app/users/status-transitions";

const ALL = Object.values(UserStatus);

function isAllowedPair(from: UserStatus, to: UserStatus): boolean {
  return (
    (from === UserStatus.Active && to === UserStatus.Suspended) ||
    (from === UserStatus.Suspended && to === UserStatus.Active)
  );
}

describe("ADMIN_TRANSITIONS (domain rule 3, admin caller)", () => {
  it("should contain exactly the pairs active to suspended and suspended to active", () => {
    const pairs = ALL.flatMap((from) => ADMIN_TRANSITIONS[from].map((to) => `${from}->${to}`)).sort();

    expect(pairs).toEqual(["active->suspended", "suspended->active"]);
  });

  it("should define an entry for every status so a new status is a compile-time decision", () => {
    expect(Object.keys(ADMIN_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it.each(
    ALL.flatMap((from) => ALL.map((to) => [from, to] as const)).filter(
      ([from, to]) => from !== to && !isAllowedPair(from, to),
    ),
  )("should refuse the pair %s to %s", (from, to) => {
    expect(ADMIN_TRANSITIONS[from]).not.toContain(to);
  });

  it("should offer no transition out of pending or rejected for an admin", () => {
    expect(ADMIN_TRANSITIONS[UserStatus.Pending]).toEqual([]);
    expect(ADMIN_TRANSITIONS[UserStatus.Rejected]).toEqual([]);
  });
});

describe("SERVICE_TRANSITIONS (domain rule 3, service caller: Cases 1, 3 and 4)", () => {
  it("should contain exactly the Care pairs, including suspended to active (ADR 0023)", () => {
    const pairs = ALL.flatMap((from) => SERVICE_TRANSITIONS[from].map((to) => `${from}->${to}`)).sort();

    expect(pairs).toEqual([
      "active->suspended",
      "pending->active",
      "pending->rejected",
      "rejected->pending",
      "suspended->active",
    ]);
  });

  it("should define an entry for every status", () => {
    expect(Object.keys(SERVICE_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it("should not let a rejected account go straight to active, or a pending one straight to suspended", () => {
    expect(SERVICE_TRANSITIONS[UserStatus.Rejected]).not.toContain(UserStatus.Active);
    expect(SERVICE_TRANSITIONS[UserStatus.Pending]).not.toContain(UserStatus.Suspended);
    expect(SERVICE_TRANSITIONS[UserStatus.Active]).not.toContain(UserStatus.Rejected);
  });
});
