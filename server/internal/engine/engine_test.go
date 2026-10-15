package engine

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func newGame(t *testing.T) (*State, time.Time) {
	t.Helper()
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	bank := NewBank([]BankQuestion{{ID: "fixture", Question: "Teacher fixture?", Options: []string{"A", "B", "C", "D"}, Answer: 0, Active: true}})
	s, err := New("game", "room", []Player{{User: User{ID: "a", Level: 1}}, {User: User{ID: "b", Level: 1}}}, DefaultBoard(100), bank, now)
	if err != nil {
		t.Fatal(err)
	}
	return s, now
}

func TestQuestionRules(t *testing.T) {
	s, now := newGame(t)
	qid := s.View.Question.ID
	if _, _, err := s.Answer("b", qid, s.AnswerIndex, now); err != ErrTurn {
		t.Fatalf("wrong player: %v", err)
	}
	if _, err := s.Roll("a", 6, now); err != ErrDiceLocked {
		t.Fatalf("locked dice: %v", err)
	}
	if _, _, err := s.Answer("a", "fake", 0, now); err != ErrQuestion {
		t.Fatalf("wrong question: %v", err)
	}
	result, events, err := s.Answer("a", qid, (s.AnswerIndex+1)%4, now)
	if err != nil || result.Result != "wrong" || result.DiceUnlocked || s.View.Players[0].Position != 0 || s.View.Players[0].XP != 0 || s.View.CurrentPlayerID != "b" || len(events) != 3 {
		t.Fatalf("wrong answer state: %+v %v", result, err)
	}
	result2, repeated, err := s.Answer("a", qid, 0, now)
	if err != nil || result2 != result || len(repeated) != 0 {
		t.Fatal("answered question must not apply twice")
	}
}

func TestCorrectScoringAndSecretExclusion(t *testing.T) {
	s, now := newGame(t)
	raw, _ := json.Marshal(s.Snapshot())
	for _, secret := range []string{"answerIndex", "correctAnswer", "explanation", "results"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("snapshot leaks %s", secret)
		}
	}
	s.View.Players[0].XP = 90
	result, _, err := s.Answer("a", s.View.Question.ID, s.AnswerIndex, now)
	if err != nil || result.Result != "correct" || !result.DiceUnlocked || result.XP != 100 || result.Coins != 5 || s.View.Players[0].Level != 2 || s.View.TurnState != "DICE_UNLOCKED" {
		t.Fatalf("bad reward: %+v %v", result, err)
	}
	if events := s.Expire(now.Add(time.Hour)); len(events) != 0 {
		t.Fatal("answered question timed out")
	}
	copy := s.Snapshot()
	copy.Players[0].Position = 99
	copy.Ladders["3"] = 99
	copy.Question.Options[0] = "changed"
	if s.View.Players[0].Position != 0 || s.View.Ladders["3"] != 22 || s.View.Question.Options[0] == "changed" {
		t.Fatal("snapshot aliases live state")
	}
}

func TestDeadlineBoundaryAndServerTimeout(t *testing.T) {
	for _, viaAnswer := range []bool{false, true} {
		s, now := newGame(t)
		if events := s.Expire(now.Add(30*time.Second - time.Nanosecond)); len(events) != 0 {
			t.Fatal("early timeout")
		}
		qid := s.View.Question.ID
		if viaAnswer {
			r, _, err := s.Answer("a", qid, s.AnswerIndex, now.Add(30*time.Second))
			if err != nil || r.Result != "timeout" {
				t.Fatal(r, err)
			}
		} else if events := s.Expire(now.Add(30 * time.Second)); len(events) != 3 {
			t.Fatal("missing timeout events")
		}
		if s.View.CurrentPlayerID != "b" || s.View.TurnNumber != 2 || s.View.Players[0].XP != 0 || s.View.Players[0].Position != 0 {
			t.Fatal("timeout failed to advance turn")
		}
		r, events, err := s.Answer("a", qid, 0, now.Add(31*time.Second))
		if err != nil || r.Result != "timeout" || len(events) != 0 {
			t.Fatal("late answer must report original timeout")
		}
	}
}

func TestMovementAndExactFinish(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		start, dice, want, steps int
		finished                 bool
	}{
		{"ladder", 0, 3, 22, 4, false},
		{"snake", 14, 3, 7, 4, false},
		{"overshoot", 97, 4, 97, 0, false},
		{"exact", 97, 3, 100, 3, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, now := newGame(t)
			s.View.Players[0].Position = tc.start
			_, _, _ = s.Answer("a", s.View.Question.ID, s.AnswerIndex, now)
			if _, err := s.Roll("b", tc.dice, now); err != ErrTurn {
				t.Fatal("wrong player rolled")
			}
			events, err := s.Roll("a", tc.dice, now)
			if err != nil || s.View.Players[0].Position != tc.want {
				t.Fatalf("position %d err %v", s.View.Players[0].Position, err)
			}
			steps := 0
			for _, event := range events {
				if event.Event == "player:step" {
					steps++
				}
			}
			if steps != tc.steps {
				t.Fatalf("steps %d want %d", steps, tc.steps)
			}
			if events[0].Event != "dice:rolled" || events[1].Payload.(Game).TurnState != "MOVING" || events[len(events)-1].Event != "game:state" {
				t.Fatal("movement event order")
			}
			if tc.finished && (s.View.WinnerID != "a" || s.View.TurnState != "FINISHED" || s.View.Question != nil) {
				t.Fatal("missing winner")
			}
			if !tc.finished && s.View.CurrentPlayerID != "b" {
				t.Fatal("turn did not advance")
			}
		})
	}
}

func TestLeaveAndBoardValidation(t *testing.T) {
	s, now := newGame(t)
	s.Leave("a", now)
	if s.View.Status != "finished" || s.View.WinnerID != "b" {
		t.Fatal("remaining player should win")
	}
	for _, board := range []Board{
		{TotalSteps: 0},
		{TotalSteps: 100, Snakes: map[string]int{"3": 20}},
		{TotalSteps: 100, Ladders: map[string]int{"3": 20, "20": 90}},
		{TotalSteps: 100, Ladders: map[string]int{"03": 20}},
	} {
		if board.Validate() == nil {
			t.Fatal("invalid board accepted")
		}
	}
	if err := DefaultBoard(25).Validate(); err != nil {
		t.Fatal(err)
	}
}
