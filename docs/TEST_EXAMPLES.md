# Tests & Exemples v2 — HR BMW U11 Chatbot
# ⚠️  RÈGLE : ML = Maladie | MD = Mise en demeure | SÉPARÉS

---

## TESTS MÉTIER CRITIQUES (ML vs MD)

| Question | Métrique attendue | SQL généré |
|---|---|---|
| Combien de maladie ML pour PGTF ? | `maladie` → `SUM(ml)` | ✅ `SUM(ml) AS maladie` |
| Combien de mise en demeure MD pour PGTF ? | `mise_en_demeure` → `SUM(md)` | ✅ `SUM(md) AS mise_en_demeure` |
| 9adech maladie ML fi PGTF ? | `maladie` → `SUM(ml)` | ✅ `SUM(ml) AS maladie` |
| 9adech mise en demeure MD fi PGTF ? | `mise_en_demeure` → `SUM(md)` | ✅ `SUM(md) AS mise_en_demeure` |
| قداش مرض في PGTF ؟ | `maladie` → `SUM(ml)` | ✅ `SUM(ml) AS maladie` |
| قداش mise en demeure MD في PGTF ؟ | `mise_en_demeure` → `SUM(md)` | ✅ `SUM(md) AS mise_en_demeure` |

**❌ CE QUI NE DOIT JAMAIS ARRIVER :**
- `maladie = ml + md` → INTERDIT
- `maladies = SUM(ml) + SUM(md)` → INTERDIT

---

## TESTS FRANÇAIS — SQ, AC, RV

| Question | Métrique | Scope |
|---|---|---|
| Combien de SQ pour PGTF ? | sq | perimeter=PGTF |
| Donne-moi le nombre de AC dans BMW U11 | ac | plant=BMW U11 |
| Combien de RV pour le groupe G-856 ? | rv | group=G-856 |
| Nombre de SQ dans le process Assembly ? | sq | process=Assembly |
| Combien de AC dans le circuit C1 ? | ac | circuit=C1 |
| Donne-moi les RV de PGTF | rv | perimeter=PGTF |

## TESTS FRANÇAIS — NP, P, Total

| Question | Métrique | Scope |
|---|---|---|
| Combien d'absence NP dans le circuit C1 ? | np | circuit=C1 |
| Quel est le taux NP pour G-855 ? | abs_np_rate | group=G-855 |
| Total absence pour BMW U11 aujourd'hui | total_abs | plant=BMW U11 |
| Donne-moi le P pour le process Assembly | p | process=Assembly |
| Taux présence pour PGTF | taux_presence | perimeter=PGTF |

## TESTS FRANÇAIS — Delta, Heures, Retard

| Question | Métrique | Scope |
|---|---|---|
| Donne-moi le Delta Soll/IST pour WPA | delta | perimeter=WPA |
| Combien d'heures sup en Assembly ? | heures_sup | process=Assembly |
| Nombre de retards pour G-855 | retard | group=G-855 |
| Soll vs IST pour BMW U11 | soll/ist | plant=BMW U11 |

## TESTS FRANÇAIS — Résumé + Top

| Question | Intent | Scope |
|---|---|---|
| Donne-moi tous les indicateurs du groupe G-855 | get_summary | group=G-855 |
| Résumé du process Assembly | get_summary | process=Assembly |
| Quel groupe a le plus de NP aujourd'hui ? | top | group_name |
| Quel process a le plus de MD ? | top (mise_en_demeure) | process |
| Top 5 groupes par SQ | top (sq) | group_name |

---

## TESTS TUNISIEN LATIN

| Question | Métrique | Scope |
|---|---|---|
| a3tini nombre absence fi process Assembly | total_abs | process=Assembly |
| 9adech absence fi circuit C1 ? | total_abs | circuit=C1 |
| a3tini NP mta3 G-855 | np | group=G-855 |
| 9adech RV fi G-856 ? | rv | group=G-856 |
| 9adech MD fi assembly ? | mise_en_demeure | process=Assembly |
| a3tini SQ mta3 PGTF | sq | perimeter=PGTF |
| 9adech AC fi BMW U11 ? | ac | plant=BMW U11 |
| chnowa taux NP mta3 G-855 ? | abs_np_rate | group=G-855 |
| chkoun groupe akther fih NP ? | top (np) | group_name |
| a3tini résumé mta3 G-855 | get_summary | group=G-855 |
| 9adech maladie ML fi PGTF ? | maladie (=ml) | perimeter=PGTF |
| 9adech mise en demeure MD fi PGTF ? | mise_en_demeure (=md) | perimeter=PGTF |
| a3tini delta mta3 WPA | delta | perimeter=WPA |
| 9adech heures sup fi assembly ? | heures_sup | process=Assembly |
| 9adech retard fi G-855 lyoum ? | retard | group=G-855 |

---

## TESTS ARABE

| Question | Métrique | Scope |
|---|---|---|
| قداش عدد الغيابات في process Assembly ؟ | total_abs | process=Assembly |
| أعطيني عدد الغيابات في circuit C1 | total_abs | circuit=C1 |
| قداش NP في G-855 ؟ | np | group=G-855 |
| قداش RV في G-856 ؟ | rv | group=G-856 |
| قداش MD في Assembly ؟ | mise_en_demeure | process=Assembly |
| أعطيني عدد SQ في PGTF | sq | perimeter=PGTF |
| قداش AC في BMW U11 ؟ | ac | plant=BMW U11 |
| شكون أكثر groupe فيه NP ؟ | top (np) | group_name |
| أعطيني ملخص متاع G-855 | get_summary | group=G-855 |
| قداش مرض ML في PGTF ؟ | maladie (=ml) | perimeter=PGTF |
| قداش mise en demeure MD في PGTF ؟ | mise_en_demeure (=md) | perimeter=PGTF |
| أعطيني نسبة الغياب غير المخطط اليوم | abs_np_rate | plant=BMW U11 |
| ما هو عدد الحاضرين اليوم ؟ | present | plant=BMW U11 |
| أعطيني Delta متاع WPA | delta | perimeter=WPA |

---

## RÉPONSES ATTENDUES — EXEMPLES

### Q: "Combien de maladie ML pour PGTF ?"
```
🏥 Maladie ML — PGTF
📅 Date rapport : 24/06/2026

🤒 ML (Maladie) = 4
(Note: MD = Mise en demeure, indicateur séparé)
```

### Q: "Combien de mise en demeure MD pour PGTF ?"
```
⚠️ Mise en demeure MD — PGTF
📅 Date rapport : 24/06/2026

⚠️ MD (Mise en demeure) = 2
(Note: ML = Maladie, indicateur séparé)
```

### Q: "9adech SQ fi circuit C1 ?"
```
📋 SQ — C1
📅 Date: 24/06/2026

📋 SQ = 3
```

### Q: "a3tini résumé mta3 G-855"
```
📊 Résumé G-855
📅 Date: 24/06/2026

👥 Actifs: 45 | Présents: 40
❌ NP: 3 (6.67%) | 🗓️ P: 2 (4.44%)
📊 Total Abs: 5
📋 SQ: 1 | AC: 0 | RV: 1
🏥 Maladie ML: 2 | Mise/dem MD: 1
✅ Présence: 88.89%
🎯 Delta: +2.5h
```

### Q: "قداش مرض في PGTF ؟"
```
🏥 مرض ML — PGTF
📅 التاريخ: 24/06/2026

🤒 ML (مرض) = 7
(ملاحظة: MD = إنذار، مؤشر منفصل)
```

---

## VÉRIFICATION SQL

```sql
-- TEST : Vérifier que maladie = ml (jamais ml+md)
SELECT
  report_date, group_name,
  SUM(ml) AS maladie_correct,          -- ✅ ML seulement
  SUM(md) AS mise_en_demeure_correct,  -- ✅ MD seulement
  SUM(ml + md) AS JAMAIS_UTILISER      -- ❌ Ne jamais utiliser
FROM daily_hr_report
WHERE report_date = CURRENT_DATE
GROUP BY report_date, group_name;

-- TEST : Vérifier tous les indicateurs d'un groupe
SELECT
  report_date, group_name,
  actif, present, p, np, sq, ac, rv,
  ml, md, maladie, mise_en_demeure,
  abs_np_rate, abs_p_rate, total_abs,
  retard, heures_sup, soll, ist, delta
FROM daily_hr_report
WHERE group_name ILIKE 'G-855'
  AND report_date = (SELECT MAX(report_date) FROM daily_hr_report);

-- TEST : Top 5 NP
SELECT group_name, SUM(np) AS np
FROM daily_hr_report
WHERE report_date = (SELECT MAX(report_date) FROM daily_hr_report)
GROUP BY group_name ORDER BY np DESC LIMIT 5;

-- TEST : SQ par circuit
SELECT circuit, SUM(sq) AS sq
FROM daily_hr_report
WHERE report_date = (SELECT MAX(report_date) FROM daily_hr_report)
GROUP BY circuit ORDER BY sq DESC;
```

