import { DateTime } from "luxon";

export interface PayEmployee {
  payType: string;
  baseSalary: number;
  hourlyRate: number;
  salaryDivisorPolicy: string;
  joiningDate: string;
  weeklyOffDays: number[];
}
export interface PayAttendance {
  workDate: string;
  status: string;
  regularMinutes: number;
  regularApproved: boolean;
  isIncomplete: boolean;
  isOvertime: boolean;
  otAmount: number;
}
export function calculatePayroll(
  employee: PayEmployee,
  records: PayAttendance[],
  month: string,
  asOf: string,
) {
  const start = DateTime.fromISO(`${month}-01`),
    days = start.daysInMonth!;
  const divisor =
    employee.salaryDivisorPolicy === "FIXED_26"
      ? 26
      : employee.salaryDivisorPolicy === "CALENDAR"
        ? days
        : 30;
  const absences = records.filter((r) => r.status === "ABSENT").length;
  const regularMinutes = records
    .filter((r) => r.regularApproved && !r.isIncomplete)
    .reduce((sum, r) => sum + r.regularMinutes, 0);
  const approvedOt = records
    .filter((r) => r.isOvertime && !r.isIncomplete)
    .reduce((sum, r) => sum + r.otAmount, 0);
  const basePay =
    employee.payType === "SALARIED"
      ? employee.baseSalary
      : Math.round((regularMinutes * employee.hourlyRate) / 60);
  const deductions =
    employee.payType === "SALARIED"
      ? Math.round((absences * employee.baseSalary) / divisor)
      : 0;
  const warnings = [
    "Estimate only: paid-leave, half-day, prorating, and final payroll policies require business approval.",
  ];
  if (start.endOf("month").toISODate()! >= asOf)
    warnings.push("This payroll month is not closed.");
  if (records.some((r) => r.isIncomplete))
    warnings.push("Incomplete punches require correction.");
  if (records.some((r) => r.status === "PRESENT" && !r.regularApproved))
    warnings.push("Some regular hours have not been approved.");
  const dates = new Set(records.map((r) => r.workDate));
  let unmarkedDays = 0;
  for (let day = 1; day <= days; day++) {
    const date = start.set({ day }),
      iso = date.toISODate()!;
    if (
      iso > asOf ||
      iso < employee.joiningDate ||
      employee.weeklyOffDays.includes(date.weekday % 7)
    )
      continue;
    if (!dates.has(iso)) unmarkedDays++;
  }
  if (unmarkedDays)
    warnings.push(`${unmarkedDays} workdays have no attendance record.`);
  return {
    basePay,
    deductions,
    approvedOt,
    netPayable: basePay - deductions + approvedOt,
    regularMinutes,
    absences,
    unmarkedDays,
    completeness: "ESTIMATE",
    warnings,
    policy: {
      divisor,
      rounding: "Round each monthly component to the nearest minor unit",
      finalized: false,
    },
  };
}
