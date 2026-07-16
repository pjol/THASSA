package leader

import "testing"

func TestLockIDStableAndDistinct(t *testing.T) {
	relayer1 := LockID("relayer")
	relayer2 := LockID("relayer")
	settlement := LockID("settlement")
	if relayer1 != relayer2 {
		t.Fatal("lock ids must be deterministic across instances")
	}
	if relayer1 == settlement {
		t.Fatal("different workers must use different advisory locks")
	}
}
