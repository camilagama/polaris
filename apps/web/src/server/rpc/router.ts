import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import { pingSystem } from "../use-cases/system-ping";

const implementContract = implement(polarisContract);

const ping = implementContract.system.ping.handler(() => pingSystem());

export const rpcRouter = implementContract.router({
  system: { ping },
});
