import { expect } from "chai";
import { getTestingAPI } from "@/helpers/get-testing-api.js";

describe("HelloWorld", () => {
  it("starts with the default greeting", async () => {
    const { helloWorld } = await getTestingAPI();
    expect(await helloWorld.greeting()).to.equal("Hello, Pampalo");
  });

  it("lets a signer change the greeting and emits the right event", async () => {
    const { helloWorld, Signers } = await getTestingAPI();
    const [alice] = Signers;

    const tx = await helloWorld.connect(alice).setGreeting("hi from alice");
    await expect(tx)
      .to.emit(helloWorld, "GreetingChanged")
      .withArgs("Hello, Pampalo", "hi from alice", alice.address);

    expect(await helloWorld.greeting()).to.equal("hi from alice");
  });

  it("gives each test a fresh deployment", async () => {
    // Independent invocation of getTestingAPI → new in-process
    // Hardhat connection → fresh contract. If state were leaking
    // from the previous test, greeting would still be "hi from
    // alice".
    const { helloWorld } = await getTestingAPI();
    expect(await helloWorld.greeting()).to.equal("Hello, Pampalo");
  });
});
