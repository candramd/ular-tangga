package engine

import (
	"sort"
	"time"
)

// BankQuestion is the admin-managed question bank entry. It carries the answer
// key and must never be marshaled into any client-facing payload; the public
// DTO is Question, which has no answer fields.
type BankQuestion struct {
	ID          string    `json:"id"`
	Question    string    `json:"question"`
	Options     []string  `json:"options"`
	Answer      int       `json:"answer"`
	Explanation string    `json:"explanation,omitempty"`
	Category    string    `json:"category,omitempty"`
	Difficulty  string    `json:"difficulty,omitempty"`
	TimeLimit   int       `json:"timeLimit,omitempty"`
	Active      bool      `json:"active"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Bank is a per-game immutable snapshot of the active custom questions. It is
// persisted inside State so an in-flight game keeps drawing from the exact bank
// it started with, across admin edits and server restarts.
type Bank struct {
	Items []BankQuestion `json:"items,omitempty"`
}

// NewBank filters to active questions, deep-copies options, and sorts by ID so
// draw order is deterministic.
func NewBank(questions []BankQuestion) *Bank {
	active := make([]BankQuestion, 0, len(questions))
	for _, q := range questions {
		if !q.Active {
			continue
		}
		opts := make([]string, len(q.Options))
		copy(opts, q.Options)
		active = append(active, BankQuestion{
			ID:          q.ID,
			Question:    q.Question,
			Options:     opts,
			Answer:      q.Answer,
			Explanation: q.Explanation,
			Category:    q.Category,
			Difficulty:  q.Difficulty,
			TimeLimit:   q.TimeLimit,
			Active:      q.Active,
			UpdatedAt:   q.UpdatedAt,
		})
	}
	sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
	return &Bank{Items: active}
}

func (b *Bank) Empty() bool {
	return b == nil || len(b.Items) == 0
}

func (b *Bank) draw(turn int) (Question, int, string) {
	if b.Empty() {
		return Question{}, 0, ""
	}
	item := b.Items[(turn-1)%len(b.Items)]
	diff := item.Difficulty
	if diff == "" {
		diff = "mudah"
	}
	cat := item.Category
	if cat == "" {
		cat = "Umum"
	}
	tl := item.TimeLimit
	if tl <= 0 {
		tl = 30
	}
	return Question{
		Question:   item.Question,
		Options:    append([]string(nil), item.Options...),
		Category:   cat,
		Difficulty: diff,
		TimeLimit:  tl,
	}, item.Answer, item.Explanation
}
