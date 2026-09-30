# August 2026: API repair and workbook verification

The workbook is a reference only. Expense Intelligence now reads transaction rows and raw split items fetched from Pleo; it does not read expense_reconciliations or workbook files. The old reconciliation snapshot remains in the database solely as an audit record.

## Root causes fixed

- Historical import used performedAt (purchase date). It now queries settledAtStart/settledAtEnd and checks settlement dates, matching the reporting month. This includes July purchases that settled in August.
- API parent totals already include split items. Reporting replaces a parent with its split detail, checks that the amounts reconcile, and never adds both.
- Wallet spending excludes OUT_OF_POCKET and BILL_INVOICE expense records; reimbursement payments are counted when they post to the wallet. Fees, cashback and refunds remain included with their signs.

## API repair

Pleo returned 18,611 August-settled accounting entries. Existing mapping/upsert logic inserted 587 missing parent entries and refreshed 18,024. API provenance and raw payloads are stored in the database. Existing allocations and review decisions were preserved. Receipt jobs use original parent IDs.

The API contains every previously missing workbook expense ID, either as a parent or split item. Its 18,206 wallet spending lines plus 101 wallet loads match the workbook's row count and totals:

| August | GBP |
|---|---:|
| Wallet loads | 726,000.00 |
| Wallet spending | 715,291.65 |
| Remaining balance from zero opening | 10,708.35 |

September uses the same wallet-movement definition and carries forward August's balance. Its imported billed spending is 595,076.43, leaving 6,631.92; pending transactions without billed values are excluded. This is not a live wallet reconciliation or a claim that September is complete.

Regression checks cover settlement boundaries, pagination, parent/split deduplication, debit/credit signs, currency separation, non-wallet exclusions, and monthly carry-forward.
