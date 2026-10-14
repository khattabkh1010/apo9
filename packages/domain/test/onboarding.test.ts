import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidCrNumber, isValidVatNumber, onboardingChecklist, restaurantSlug, validateWeeklyHours, type OnboardingFacts } from "../src/onboarding.ts";

const ready: OnboardingFacts = { nameAr: "مطعم", cuisineTags: ["برجر"], crNumber: "1010123456", branches: 1, branchesWithHours: 1, pricedItems: 3, categories: 1, termsAcceptedAt: new Date(), coverageRules: 1 };

test("onboarding: activation needs every restaurant step plus ops coverage", () => {
  assert.equal(onboardingChecklist(ready).readyForActivation, true);
  const noCoverage = onboardingChecklist({ ...ready, coverageRules: 0 });
  assert.equal(noCoverage.restaurantStepsDone, true);
  assert.equal(noCoverage.readyForActivation, false);
  for (const broken of [{ pricedItems: 2 }, { termsAcceptedAt: null }, { branchesWithHours: 0 }, { crNumber: "123" }, { cuisineTags: [] }]) {
    const c = onboardingChecklist({ ...ready, ...broken });
    assert.equal(c.readyForActivation, false, JSON.stringify(broken));
    assert.equal(c.restaurantStepsDone, false, JSON.stringify(broken));
  }
});

test("onboarding: Saudi CR and VAT number formats", () => {
  assert.ok(isValidCrNumber("1010123456"));
  assert.ok(!isValidCrNumber("101012345"));
  assert.ok(isValidVatNumber("300123456700003"));
  assert.ok(!isValidVatNumber("200123456700003"));
  assert.ok(!isValidVatNumber("30012345670000"));
});

test("opening hours: overnight ranges allowed, overlaps and bad times rejected", () => {
  assert.deepEqual(validateWeeklyHours({ "4": [["16:00", "02:00"]], "5": [["13:00", "16:00"], ["19:00", "24:00"]] }), []);
  assert.equal(validateWeeklyHours({ "1": [["12:00", "15:00"], ["14:00", "18:00"]] }).length, 1);
  assert.equal(validateWeeklyHours({ "1": [["25:00", "26:00"]] }).length, 1);
  assert.equal(validateWeeklyHours({ "7": [["12:00", "13:00"]] }).length, 1);
  assert.equal(validateWeeklyHours({ "1": [["12:00", "12:00"]] }).length, 1);
});

test("restaurant slug", () => {
  assert.equal(restaurantSlug("Najd Burger & Co.", "a1b2"), "najd-burger-co-a1b2");
  assert.equal(restaurantSlug("مطعم", "x9"), "restaurant-x9");
});
