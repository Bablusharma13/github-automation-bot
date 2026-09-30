import { describe, expect, it } from "vitest";
import { retryDelaySeconds } from "@/server/jobs/backoff";
import { ruleMatchesEvent } from "@/server/rules/match";

describe("retryDelaySeconds", () => {
  const noJitter = () => 0.5;
  it("doubles from 30s per attempt", () => {
    expect([1, 2, 3, 4, 5].map((a) => retryDelaySeconds(a, noJitter))).toEqual([30, 60, 120, 240, 480]);
  });
  it("is capped at one hour", () => {
    expect(retryDelaySeconds(20, noJitter)).toBe(3600);
  });
  it("applies at most ±20% jitter", () => {
    expect(retryDelaySeconds(2, () => 0)).toBe(48);
    expect(retryDelaySeconds(2, () => 0.999999)).toBe(72);
  });
});

describe("ruleMatchesEvent", () => {
  const rule = {
    enabled: true,
    eventType: "issues" as const,
    eventActions: ["opened"],
    keywords: ["bug"],
    keywordScope: "title" as const,
  };
  const event = (title: string, body = "", action = "opened", eventType = "issues") => ({
    eventType,
    action,
    subject: {
      kind: "issue" as const,
      number: 1,
      title,
      body,
      url: "u",
      state: "open",
      author: "a",
      labels: [],
    },
  });

  it("matches a keyword case-insensitively in the title", () => {
    expect(ruleMatchesEvent(rule, event("BUG: login button is broken"))).toBe(true);
  });
  it("does not match when the keyword is absent", () => {
    expect(ruleMatchesEvent(rule, event("Feature: dark mode"))).toBe(false);
  });
  it("only searches the body when the scope says so", () => {
    expect(ruleMatchesEvent(rule, event("Crash on save", "this is a bug"))).toBe(false);
    expect(
      ruleMatchesEvent({ ...rule, keywordScope: "title_and_body" }, event("Crash on save", "this is a bug")),
    ).toBe(true);
  });
  it("matches any of several keywords, ignoring blanks", () => {
    expect(
      ruleMatchesEvent({ ...rule, keywords: [" ", "crash", "regression"] }, event("App crash on start")),
    ).toBe(true);
  });
  it("matches everything of the type/action when there are no keywords", () => {
    expect(ruleMatchesEvent({ ...rule, keywords: [] }, event("anything"))).toBe(true);
  });
  it("respects enabled, event type and action", () => {
    expect(ruleMatchesEvent({ ...rule, enabled: false }, event("bug"))).toBe(false);
    expect(ruleMatchesEvent(rule, event("bug", "", "opened", "pull_request"))).toBe(false);
    expect(ruleMatchesEvent(rule, event("bug", "", "closed"))).toBe(false);
  });
});
