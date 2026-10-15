package engine

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestBankNewBankFiltersInactiveAndSorts(t *testing.T) {
	now := time.Now()
	qs := []BankQuestion{
		{ID: "q-c", Question: "C", Options: []string{"1", "2"}, Answer: 0, Active: true, UpdatedAt: now},
		{ID: "q-a", Question: "A", Options: []string{"1", "2"}, Answer: 0, Active: true, UpdatedAt: now},
		{ID: "q-b", Question: "B", Options: []string{"1", "2"}, Answer: 0, Active: false, UpdatedAt: now},
	}
	b := NewBank(qs)
	if b.Empty() {
		t.Fatal("bank should not be empty")
	}
	if len(b.Items) != 2 {
		t.Fatalf("expected 2 active items, got %d", len(b.Items))
	}
	if b.Items[0].ID != "q-a" || b.Items[1].ID != "q-c" {
		t.Fatalf("items not sorted by ID: %v", b.Items)
	}
}

func TestBankEmptyWhenAllInactive(t *testing.T) {
	b := NewBank([]BankQuestion{
		{ID: "q-1", Question: "Q", Options: []string{"1", "2"}, Answer: 0, Active: false},
	})
	if !b.Empty() {
		t.Fatal("bank with only inactive questions should be empty")
	}
}

func TestBankDrawCyclesDeterministically(t *testing.T) {
	now := time.Now()
	qs := []BankQuestion{
		{ID: "q-1", Question: "First", Options: []string{"A", "B"}, Answer: 0, Active: true, UpdatedAt: now, TimeLimit: 45},
		{ID: "q-2", Question: "Second", Options: []string{"C", "D"}, Answer: 1, Active: true, UpdatedAt: now, TimeLimit: 60},
		{ID: "q-3", Question: "Third", Options: []string{"E", "F"}, Answer: 0, Active: true, UpdatedAt: now, TimeLimit: 20},
	}
	b := NewBank(qs)

	q1, a1, e1 := b.draw(1)
	if q1.Question != "First" || a1 != 0 || e1 != "" {
		t.Fatalf("turn 1: %+v %d %q", q1, a1, e1)
	}
	if q1.TimeLimit != 45 {
		t.Fatalf("turn 1 timeLimit: %d", q1.TimeLimit)
	}

	q2, a2, e2 := b.draw(2)
	if q2.Question != "Second" || a2 != 1 || e2 != "" {
		t.Fatalf("turn 2: %+v %d %q", q2, a2, e2)
	}
	if q2.TimeLimit != 60 {
		t.Fatalf("turn 2 timeLimit: %d", q2.TimeLimit)
	}

	q3, a3, e3 := b.draw(3)
	if q3.Question != "Third" || a3 != 0 || e3 != "" {
		t.Fatalf("turn 3: %+v %d %q", q3, a3, e3)
	}
	if q3.TimeLimit != 20 {
		t.Fatalf("turn 3 timeLimit: %d", q3.TimeLimit)
	}

	q4, a4, e4 := b.draw(4)
	if q4.Question != "First" || a4 != 0 || e4 != "" {
		t.Fatalf("turn 4 cycles: %+v %d %q", q4, a4, e4)
	}
}

func TestBankNilEmptyRejectsNewGame(t *testing.T) {
	for _, bank := range []*Bank{nil, NewBank(nil), NewBank([]BankQuestion{{ID: "inactive", Active: false}})} {
		s, err := New("game", "room", []Player{{User: User{ID: "a"}}, {User: User{ID: "b"}}}, DefaultBoard(100), bank, time.Now())
		if err != ErrBankEmpty || s != nil {
			t.Fatalf("empty teacher bank accepted: %v", err)
		}
	}
}

func TestBankOptionsCopied(t *testing.T) {
	now := time.Now()
	orig := []string{"A", "B"}
	b := NewBank([]BankQuestion{{ID: "q-1", Question: "Q", Options: orig, Answer: 0, Active: true, UpdatedAt: now}})
	orig[0] = "MUTATED"
	q, _, _ := b.draw(1)
	if q.Options[0] != "A" {
		t.Fatal("options slice not copied")
	}
}

func TestStateAttachBankUsedAfterRestore(t *testing.T) {
	s, now := newGame(t)
	_ = s.View.Question.Question

	qs := []BankQuestion{{ID: "q-1", Question: "Custom", Options: []string{"X", "Y"}, Answer: 1, Active: true, UpdatedAt: now}}
	s.AttachBank(NewBank(qs))
	s.next(0, now)
	if s.View.Question.Question != "Custom" || s.AnswerIndex != 1 {
		t.Fatalf("AttachBank not used: %s ans=%d", s.View.Question.Question, s.AnswerIndex)
	}
}

func TestStateBankSnapshotNotLeaked(t *testing.T) {
	s, _ := newGame(t)
	snap := s.Snapshot()
	for _, secret := range []string{"answerIndex", "correctAnswer", "explanation", "results", "bank"} {
		raw, _ := json.Marshal(snap)
		if strings.Contains(string(raw), secret) {
			t.Fatalf("snapshot leaks %s", secret)
		}
	}
}
