-- ระบบเบิก/คืนเครื่อง (ติดตามด้วย IMEI)
-- วิธีใช้: Supabase Dashboard → SQL Editor → วางทั้งไฟล์ → Run
-- (รันซ้ำได้อย่างปลอดภัย ไม่ลบข้อมูลเดิม)

-- ───────── ตาราง ─────────
create table if not exists public.documents (
  doc_no      text primary key,
  type        text not null check (type in ('ISSUE','RETURN')),
  person      text not null,
  dept        text not null default '',
  purpose     text not null default '',
  note        text not null default '',
  by_name     text not null default '',
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.document_items (
  id      bigint generated always as identity primary key,
  doc_no  text not null references public.documents(doc_no) on delete cascade,
  imei    text not null,
  model   text not null default ''
);
create index if not exists document_items_doc_idx  on public.document_items(doc_no);
create index if not exists document_items_imei_idx on public.document_items(imei);

-- 1 แถว = การเบิกเครื่อง 1 ครั้ง; returned_at เป็น null = ยังค้างอยู่กับผู้เบิก
create table if not exists public.loans (
  id          bigint generated always as identity primary key,
  imei        text not null,
  model       text not null default '',
  person      text not null,
  dept        text not null default '',
  purpose     text not null default '',
  issue_doc   text not null references public.documents(doc_no),
  issued_at   timestamptz not null default now(),
  issued_by   text not null default '',
  return_doc  text references public.documents(doc_no),
  returned_at timestamptz,
  returned_by text
);
-- กันเบิกเครื่องเดียวกันซ้อน (บังคับที่ฐานข้อมูล แม้ 2 คนยิงพร้อมกัน)
create unique index if not exists loans_one_open_per_imei on public.loans(imei) where returned_at is null;
create index if not exists loans_imei_idx   on public.loans(imei);
create index if not exists loans_person_idx on public.loans(person);

create table if not exists public.doc_counters (
  prefix text not null,
  day    text not null,
  n      int  not null default 0,
  primary key (prefix, day)
);

-- ───────── เลขที่เอกสาร (เวลาไทย) ─────────
create or replace function public.next_doc_no(p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare d text := to_char(now() at time zone 'Asia/Bangkok', 'YYMMDD'); k int;
begin
  insert into doc_counters(prefix, day, n) values (p_prefix, d, 1)
  on conflict (prefix, day) do update set n = doc_counters.n + 1
  returning n into k;
  return p_prefix || '-' || d || '-' || lpad(k::text, 3, '0');
end $$;

-- ───────── เบิกเครื่อง (atomic) ─────────
-- p_items: [{"imei":"350000000000000","model":"iPhone 15"}, ...]
create or replace function public.issue_devices(
  p_person text, p_dept text, p_purpose text, p_note text, p_by text, p_items jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_no text; it jsonb; v_imei text; v_model text; v_holder text;
begin
  if auth.uid() is null then raise exception 'ต้องเข้าสู่ระบบก่อน'; end if;
  if coalesce(trim(p_person), '') = '' then raise exception 'กรุณาระบุผู้เบิก'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ยังไม่มีเครื่องที่จะเบิก';
  end if;

  v_no := next_doc_no('ISS');
  insert into documents(doc_no, type, person, dept, purpose, note, by_name)
  values (v_no, 'ISSUE', trim(p_person), coalesce(trim(p_dept),''), coalesce(trim(p_purpose),''),
          coalesce(trim(p_note),''), coalesce(trim(p_by),''));

  for it in select * from jsonb_array_elements(p_items) loop
    v_imei  := upper(trim(it->>'imei'));
    v_model := coalesce(trim(it->>'model'), '');
    if v_imei !~ '^[A-Z0-9-]{5,30}$' then raise exception 'IMEI/ซีเรียล % ไม่ถูกต้อง', v_imei; end if;
    begin
      insert into loans(imei, model, person, dept, purpose, issue_doc, issued_by)
      values (v_imei, v_model, trim(p_person), coalesce(trim(p_dept),''), coalesce(trim(p_purpose),''), v_no, coalesce(trim(p_by),''));
    exception when unique_violation then
      select person into v_holder from loans where imei = v_imei and returned_at is null;
      raise exception 'IMEI % ถูกเบิกอยู่แล้ว (ผู้เบิก: %)', v_imei, coalesce(v_holder, '-');
    end;
    insert into document_items(doc_no, imei, model) values (v_no, v_imei, v_model);
  end loop;
  return v_no;
end $$;

-- ───────── คืนเครื่อง (atomic) ─────────
create or replace function public.return_devices(p_imeis text[], p_by text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_no text; v_imei text; l loans%rowtype; v_persons text[] := '{}'; v_person text; v_dept text := '';
begin
  if auth.uid() is null then raise exception 'ต้องเข้าสู่ระบบก่อน'; end if;
  if p_imeis is null or array_length(p_imeis, 1) is null then raise exception 'ยังไม่มีเครื่องที่จะคืน'; end if;

  -- ตรวจทุกเครื่องก่อน (ล็อกแถวไว้) เพื่อรู้ชื่อผู้คืน
  foreach v_imei in array p_imeis loop
    v_imei := upper(trim(v_imei));
    select * into l from loans where imei = v_imei and returned_at is null for update;
    if not found then raise exception 'IMEI % ไม่ได้อยู่ในสถานะถูกเบิก', v_imei; end if;
    if not (l.person = any(v_persons)) then v_persons := v_persons || l.person; end if;
    v_dept := l.dept;
  end loop;
  v_person := case when array_length(v_persons, 1) = 1 then v_persons[1] else 'หลายคน: ' || array_to_string(v_persons, ', ') end;

  v_no := next_doc_no('RET');
  insert into documents(doc_no, type, person, dept, note, by_name)
  values (v_no, 'RETURN', v_person, case when array_length(v_persons,1)=1 then v_dept else '' end,
          coalesce(trim(p_note),''), coalesce(trim(p_by),''));

  foreach v_imei in array p_imeis loop
    v_imei := upper(trim(v_imei));
    update loans set returned_at = now(), return_doc = v_no, returned_by = coalesce(trim(p_by),'')
    where imei = v_imei and returned_at is null
    returning * into l;
    insert into document_items(doc_no, imei, model) values (v_no, v_imei, l.model);
  end loop;
  return v_no;
end $$;

-- ───────── สิทธิ์ (RLS): ล็อกอินแล้วอ่านได้ / เขียนได้ผ่านฟังก์ชันเท่านั้น ─────────
alter table public.documents       enable row level security;
alter table public.document_items  enable row level security;
alter table public.loans           enable row level security;
alter table public.doc_counters    enable row level security;

drop policy if exists "read documents"      on public.documents;
drop policy if exists "read document_items" on public.document_items;
drop policy if exists "read loans"          on public.loans;
create policy "read documents"      on public.documents      for select to authenticated using (true);
create policy "read document_items" on public.document_items for select to authenticated using (true);
create policy "read loans"          on public.loans          for select to authenticated using (true);

revoke all on public.documents, public.document_items, public.loans, public.doc_counters from anon, authenticated;
grant select on public.documents, public.document_items, public.loans to authenticated;

revoke all on function public.next_doc_no(text) from public, anon, authenticated;
revoke all on function public.issue_devices(text,text,text,text,text,jsonb) from public, anon;
revoke all on function public.return_devices(text[],text,text) from public, anon;
grant execute on function public.issue_devices(text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.return_devices(text[],text,text) to authenticated;
