# ระบบเบิก/คืนเครื่อง (IMEI)

PWA แบบ vanilla JS ไม่มี framework — ข้อมูลเก็บบน **Supabase** (Postgres + Auth) และ Deploy บน **Vercel**

ฟีเจอร์: ล็อกอิน · เบิกเครื่อง (สแกน IMEI) · คืนเครื่อง · รายการเครื่องที่ค้างอยู่ · ประวัติ/พิมพ์ใบเบิก-คืน · ส่งออก CSV
(ไม่มีระบบสต็อก/จำนวนคงเหลือ — ติดตามเฉพาะว่าเครื่อง IMEI ไหนอยู่กับใคร)

## 1) ตั้งค่า Supabase
1. สร้างโปรเจกต์ที่ https://supabase.com
2. **SQL Editor** → วางไฟล์ `supabase/schema.sql` ทั้งไฟล์ → **Run**
3. **Authentication → Users → Add user** สร้างบัญชีให้ผู้ใช้แต่ละคน (อีเมล + รหัสผ่าน, ติ๊ก Auto Confirm)
   แนะนำปิด **Authentication → Sign In / Providers → Allow new users to sign up** เพื่อไม่ให้คนนอกสมัครเอง
4. **Project Settings → API** คัดลอก `Project URL` และ `anon public` key

## 2) Deploy บน Vercel
1. push โฟลเดอร์นี้ขึ้น GitHub แล้ว **Add New → Project** เลือก repo (Framework Preset: *Other*)
   — `vercel.json` ตั้ง build command และ output directory (`public`) ไว้แล้ว
2. **Settings → Environment Variables** เพิ่ม
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon public key
   (ถ้าใช้ Supabase Integration ของ Vercel ชื่อ `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` ก็ใช้ได้เลย)
3. Deploy — `build.js` จะสร้าง `public/config.js` จากค่าเหล่านี้ (ถ้าไม่ตั้งค่า build จะล้มพร้อมข้อความบอก)

หรือใช้ CLI: `npm i -g vercel && vercel --prod`

> anon key เป็นคีย์สาธารณะโดยออกแบบ ความปลอดภัยอยู่ที่ RLS: ต้องล็อกอินจึงอ่านได้ และเขียนได้ผ่านฟังก์ชัน
> `issue_devices` / `return_devices` เท่านั้น **ห้ามใส่ `service_role` key ในแอปเด็ดขาด**

## รันในเครื่อง
แก้ `public/config.js` ใส่ URL/key แล้ว `npx serve public` (กล้องใช้ได้บน `localhost` หรือ HTTPS เท่านั้น)

## โครงสร้าง
```
public/            ไฟล์เว็บ (index.html, app.js, style.css, sw.js, manifest, icons, config.js)
supabase/schema.sql  ตาราง + ฟังก์ชัน + RLS
build.js           สร้าง config.js จาก env ตอน build
vercel.json        build/headers
```

## หมายเหตุการทำงาน
- เบิก/คืนเป็น transaction เดียวทั้งใบ และมี unique index กันเบิกเครื่องเดียวกันซ้อน แม้ 2 คนสแกนพร้อมกัน
- เลขที่เอกสารรูปแบบ `ISS-YYMMDD-001` / `RET-YYMMDD-001` ตามวันเวลาไทย
- ต้องออนไลน์จึงบันทึกได้ (service worker แคชเฉพาะตัวแอป) ร่างที่ยังไม่ยืนยันจะถูกเก็บในเครื่อง
