import { redirect } from "next/navigation";

export default function StatusPage(): never {
  redirect("/support");
}
