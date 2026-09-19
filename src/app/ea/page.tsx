import { redirect } from "next/navigation";

// /ea は /traders へリダイレクト（旧EA → AIトレーダーへ移行済み）
export default function EARedirectPage() {
  redirect("/traders");
}
