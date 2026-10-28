import { mountAdmin } from "./app";

const root = document.getElementById("admin");
if (root !== null) {
  mountAdmin(root, (input, init) => fetch(input, init));
}
