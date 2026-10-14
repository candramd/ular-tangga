import type { Metadata } from "next";
import AdminApp from "@/components/AdminApp";
import "../admin/admin.css";

export const metadata: Metadata = {
  title: "Panel Guru | Ular Tangga Adventure",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminApp />;
}
