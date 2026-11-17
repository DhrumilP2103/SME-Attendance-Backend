import { DateTime } from "luxon";
import mongoose from "mongoose";
import argon2 from "argon2";
import {
  User,
  Employee,
  Attendance,
  Counter,
  CronConfig,
} from "../modules/models.js";
import { localDemo } from "../config/env.js";

export async function seedDemo() {
  if (!localDemo || (await User.exists({}))) return;
  const people = [
    ["Priya Sharma", "HR"],
    ["Arjun Patel", "EMPLOYEE"],
    ["Sarah Chen", "EMPLOYEE"],
    ["Rahul Verma", "EMPLOYEE"],
    ["Emily Wilson", "EMPLOYEE"],
    ["Vikram Singh", "EMPLOYEE"],
    ["Ananya Desai", "EMPLOYEE"],
    ["James Miller", "EMPLOYEE"],
    ["Neha Gupta", "EMPLOYEE"],
    ["Daniel Lee", "EMPLOYEE"],
    ["Isha Mehta", "EMPLOYEE"],
    ["Rohan Shah", "EMPLOYEE"],
    ["Sophie Taylor", "EMPLOYEE"],
    ["Kabir Khan", "EMPLOYEE"],
    ["Maya Thomas", "EMPLOYEE"],
  ];
  await mongoose.connection.transaction(async (session) => {
    const adminPasswordHash = await argon2.hash("Admin@123");
    await User.create(
      [
        {
          name: "System Admin",
          email: "admin@gmail.com",
          passwordHash: adminPasswordHash,
          role: "ADMIN",
          isActive: true,
          activated: true,
          demo: true,
        },
      ],
      { session },
    );
    const now = DateTime.now().setZone("Asia/Kolkata");
    for (const [index, person] of people.entries()) {
      const [name, role] = person;
      const userEmail = `${name.toLowerCase().replaceAll(" ", ".")}@sme.test`;
      const [user] = await User.create(
        [
          {
            name,
            email: userEmail,
            role,
            activated: true,
            demo: true,
          },
        ],
        { session },
      );
      const [emp] = await Employee.create(
        [
          {
            userId: user._id,
            employeeCode: `EMP-${1001 + index}`,
            fullName: name,
            email: user.email,
            phone: `+91 98765 ${String(43210 + index)}`,
            joiningDate: "2024-01-15",
            payType: index === 11 ? "HOURLY" : "SALARIED",
            baseSalary: (45000 + index * 2500) * 100,
            hourlyRate: 35000,
            assignedClientOrCustomer: null,
          },
        ],
        { session },
      );
      for (let day = 0; day < 30; day++) {
        if (day === 0 && index === 0) continue;
        const date = now.minus({ days: day }),
          workDate = date.toISODate()!;
        const absent = (index + day * 3) % 17 === 0,
          leave = !absent && (index + day) % 19 === 0;
        const half = !absent && !leave && (index + day) % 23 === 0;
        const holiday = day > 0 && date.weekday === 7;
        const status = holiday
          ? "HOLIDAY"
          : absent
            ? "ABSENT"
            : leave
              ? "LEAVE"
              : half
                ? "HALF_DAY"
                : "PRESENT";
        const working = ["PRESENT", "HALF_DAY"].includes(status);
        const inTime = working
          ? date
              .set({
                hour: 9,
                minute: (index % 4) * 7,
                second: 0,
                millisecond: 0,
              })
              .toJSDate()
          : null;
        if (inTime && inTime.getTime() > Date.now()) continue;
        const plannedOut = date
          .set({
            hour: half ? 13 : 18,
            minute: (index % 3) * 5,
            second: 0,
            millisecond: 0,
          })
          .toJSDate();
        const outTime =
          working &&
          (day > 0 || (plannedOut.getTime() < Date.now() && index % 5 !== 0))
            ? plannedOut
            : null;
        const ot = Boolean(outTime && !half && index % 5 === 0);
        await Attendance.create(
          [
            {
              employeeId: emp._id,
              workDate,
              status,
              inTime,
              outTime,
              totalHours:
                outTime && inTime
                  ? (outTime.getTime() - inTime.getTime()) / 3600000
                  : 0,
              regularMinutes: outTime ? (half ? 240 : 480) : 0,
              regularApproved: Boolean(outTime),
              isIncomplete: working && !outTime && now.hour >= 20,
              isOvertime: ot,
              otAmount: ot ? 50000 : 0,
              otRemark: ot ? "Additional support for the client release." : "",
              markedBy: user._id,
            },
          ],
          { session },
        );
      }
    }
    await Counter.updateOne({ key: "employee" }, { value: 1016 }, { session });
    await CronConfig.updateOne(
      {},
      { adminRecipients: ["admin@gmail.com"] },
      { session },
    );
  });
  console.log(
    "Local demo workspace initialized. Use Explore local demo on the login screen.",
  );
}
