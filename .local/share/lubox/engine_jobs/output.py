"""Bound retained workload output without interrupting the approved process."""


NOTICE = "\n[Container output truncated; exit status is reported separately. Redirect full logs to a granted artifact path.]\n"


class WorkloadOutput:
    def __init__(self, limit):
        self.notice = NOTICE[:max(0, limit)]
        self.limit = max(0, limit - len(self.notice.encode()))
        self.head_limit = self.limit // 2
        self.tail_limit = self.limit - self.head_limit
        self.head, self.tail = bytearray(), bytearray()
        self.total = 0

    def append(self, chunk):
        self.total += len(chunk)
        prefix = min(len(chunk), self.head_limit - len(self.head))
        self.head.extend(chunk[:prefix])

        if self.tail_limit:
            self.tail.extend(chunk[prefix:][-self.tail_limit:])
            del self.tail[:max(0, len(self.tail) - self.tail_limit)]

    def finish(self):
        whole = (self.head + self.tail).decode("utf-8", "replace")
        truncated = self.total > self.limit or len(whole.encode()) > self.limit
        if not truncated:
            return whole, {"truncated": False, "outputBytes": self.total,
                           "retainedOutputBytes": len(whole.encode())}

        # Decode clipped ranges without replacement bytes exceeding the output budget.
        head = self.head.decode("utf-8", "ignore")
        tail = self.tail.decode("utf-8", "ignore")
        text = head + self.notice + tail
        return text, {"truncated": truncated, "outputBytes": self.total,
                      "retainedOutputBytes": len((head + tail).encode())}
